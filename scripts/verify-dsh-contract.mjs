#!/usr/bin/env node
/**
 * Verify the DSH plugin contracts this package depends on against a real DSH
 * installation, instead of trusting the hand-written Typert contributions.
 *
 * The plugin speaks three undocumented-in-source DSH interfaces: generated
 * `strict` Remote codecs, the Typert registry, and the client API Gateway. A DSH
 * upgrade can change any of them, so this script extracts the relevant runtime
 * bundles from the installed application and re-checks that:
 *
 *   1. the real Typert registry accepts `hostContribution` and decodes requests;
 *   2. the real client Gateway mounts `remoteContribution` and invokes it;
 *   3. the *built* `lib/client.js` mounts the namespace and its `@` source
 *      returns tabs, which is what the menus do.
 *
 * Usage (after `npm ci`):
 *
 *   node scripts/verify-dsh-contract.mjs --asar "<path to app.asar>"
 *
 * The archive is extracted into `.local/dsh-extract` (Git-ignored) so its bare
 * imports still resolve against this repository's `node_modules`; `--out` moves
 * that directory.
 */
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { transform } from "esbuild";
import assert from "node:assert/strict";
import * as cordis from "@deepseek-ai/cordis";
import { Context } from "@deepseek-ai/cordis";
import { PACKAGE, descriptors, hostContribution, remoteContribution } from "../src/protocol.js";
import { compactReferences } from "../src/reference-folders.js";
import { balanceFileReferences } from "../src/file-references.js";
import { verifyDraftInput } from "./verify-dsh-drafts.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const argument = name => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const archive = argument("--asar");
const output = path.resolve(root, argument("--out") ?? ".local/dsh-extract");
const relativeRoot = path.relative(output, path.resolve(root));
if (output === path.parse(output).root || relativeRoot === ""
  || (!path.isAbsolute(relativeRoot) && relativeRoot !== ".." && !relativeRoot.startsWith(`..${path.sep}`))) {
  throw new Error("--out must be a dedicated directory, not the repository root or its parent");
}

if (!archive) {
  console.error("verify-dsh-contract: pass --asar <path to app.asar>.");
  process.exit(2);
}
try { await stat(archive); }
catch { console.error(`verify-dsh-contract: archive not found: ${archive}`); process.exit(2); }

/** Read the ASAR directory table and extract the requested suffixes. */
async function extract(suffixes) {
  const { open } = await import("node:fs/promises");
  const handle = await open(archive, "r");
  try {
    const header = Buffer.alloc(16);
    await handle.read(header, 0, 16, 0);
    const size = header.readUInt32LE(12);
    const directory = Buffer.alloc(size);
    await handle.read(directory, 0, size, 16);
    const base = 8 + header.readUInt32LE(4);
    const files = [];
    (function walk(node, prefix) {
      for (const [name, entry] of Object.entries(node.files ?? {})) {
        const full = prefix ? `${prefix}/${name}` : name;
        if (entry.files) walk(entry, full);
        else files.push({ path: full, offset: base + Number(entry.offset), size: entry.size });
      }
    })(JSON.parse(directory.toString("utf8")));
    const extracted = new Map();
    for (const suffix of suffixes) {
      const alternatives = [suffix, suffix === "dsh-api-gateway/lib/client.js" ? "dsh-api-gateway/lib/client.browser.js" : suffix];
      const file = alternatives.map(name => files.find(candidate => candidate.path.split("\\").join("/").endsWith(`/${name}`))).find(Boolean);
      assert.ok(file, `bundle not found in the archive: ${suffix}`);
      const buffer = Buffer.alloc(file.size);
      await handle.read(buffer, 0, file.size, file.offset);
      const target = path.join(output, suffix);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, buffer);
      extracted.set(suffix, target);
    }
    return extracted;
  } finally { await handle.close(); }
}

/** Load one DSH client bundle: it registers itself with the shell module loader. */
async function loadClientBundle(file, stubs = {}) {
  const modules = new Map();
  globalThis.window = { addEventListener() {}, removeEventListener() {}, __ModuleLoader__: { load: entry => modules.set(entry.id, entry.factory) } };
  new Function("window", await readFile(file, "utf8"))(globalThis.window);
  const entry = [...modules.entries()][0];
  assert.ok(entry, `${path.basename(file)} did not register with the module loader`);
  if (path.resolve(file) === path.resolve(root, "lib/client.js")) assert.equal(entry[0], PACKAGE, "client loader ID must match the package");
  const external = { "@deepseek-ai/cordis": cordis, ...stubs };
  return entry[1](id => {
    if (external[id] === undefined) throw new Error(`${path.basename(file)} required unexpected module ${id}`);
    return external[id];
  });
}

async function verifyRegistry(bundle) {
  const { TypertRegistry } = await import(pathToFileURL(bundle).href);
  const context = new Context();
  new TypertRegistry(context);
  const dispose = context.typert.register(hostContribution);
  const payloads = { list: { query: "docs" }, setup: {}, focus: { ref: "dsh-browser://profile/1" }, apps: { query: "Unity" }, annotationSession: { client: "verify", revision: 1, sessionId: "verify", title: "Test", active: true }, manage: {}, diagnostics: {} };
  for (const descriptor of descriptors) {
    const registered = context.typert.local.get(`${descriptor.namespace}/${descriptor.method}`);
    assert.equal(registered?.id, descriptor.id, `${descriptor.method} must register`);
    assert.deepEqual(registered.parameters[0].codec.create().parse(payloads[descriptor.method]),
      payloads[descriptor.method]);
  }
  assert.throws(() => context.typert.local.get("browserTabs/list").parameters[0].codec.create().parse({ query: 7 }),
    /must be a string/);
  await dispose();
  await context.fiber.dispose();
  console.log("PASS: the real Typert registry accepts the host contribution and decodes its requests.");
}

function fakeConnection(calls, reply) {
  return {
    rpc: { open: () => undefined, call: async (channel, endpoint, payload) => {
      calls.push({ channel, endpoint, args: payload.args });
      return reply(endpoint, payload.args);
    } },
    start: () => ({ stop() {} }),
    registerGenerationSource: () => () => {},
    isLoopback: true,
    generation: { getSnapshot: () => ({ host: { home: os.homedir() } }) },
  };
}

async function verifyGateway(bundle) {
  const gateway = await loadClientBundle(bundle);
  const calls = [];
  const connection = fakeConnection(calls, endpoint => ({
    ok: true,
    value: endpoint === "browserTabs/list" ? { tabs: [], connected: false }
      : endpoint === "browserTabs/setup" ? { url: "http://127.0.0.1:43187/setup", extensionPath: "/extension" }
        : { ok: true },
  }));
  const context = new Context();
  context.provide("connection", connection);
  context.provide("typert", { remotes: { register: () => () => {} } });
  gateway.apply(context);
  const dispose = await context.remote.$mount(remoteContribution);
  assert.ok(context.remote.browserTabs, "the contribution must mount remote.browserTabs");
  const listed = await context.remote.browserTabs.list({ query: "docs" });
  assert.deepEqual(listed, { ok: true, value: { tabs: [], connected: false } });
  assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-1))),
    { channel: "/api", endpoint: "browserTabs/list", args: { request: { query: "docs" } } });
  // Negative control: the `src-json` markers this package used before 0.1.2 are refused.
  await assert.rejects(context.remote.$mount({ package: `${PACKAGE}-src`, descriptors: descriptors.map(descriptor => ({
    ...descriptor,
    parameters: descriptor.parameters.map(parameter => ({ ...parameter, codec: { mode: "src-json" } })),
    result: { mode: "src-json" },
  })) }), /strict codec/);
  await dispose();
  await context.fiber.dispose();
  console.log("PASS: the real client Gateway mounts and invokes the Remote contribution.");
}

async function verifyBuiltClient(gatewayBundle, inputBundle) {
  let built; const cleanups = [];
  try {
    built = await loadClientBundle(path.resolve(root, "lib/client.js"), {
      react: { createElement: () => null, useState: () => [undefined, () => {}], useEffect: effect => cleanups.push(effect()) },
      "@deepseek-ai/dsh-client-ui-primitives": { IconGlobeOutlineRegular: () => null },
    });
  } catch (error) {
    console.log(`SKIP: lib/client.js is not usable yet (${error.message}); run \`npm run build\` to include this check.`);
    return;
  }
  const gateway = await loadClientBundle(gatewayBundle);
  const tab = { ref: "dsh-browser://profile/7", title: "Example", url: "https://example.com/page", browser: "Edge" };
  const calls = [];
  const draft = { sessionId: "verify", requestId: "verify-note", content: [{ type: "text", text: "Fix this button" }] };
  const connection = fakeConnection(calls, (endpoint, args) => ({ ok: true,
    value: endpoint === "browserTabs/list" ? { tabs: [tab], connected: true }
      : endpoint === "browserTabs/annotationSession" ? { ok: true, drafts: args.request.active ? [draft] : [] } : { ok: true } }));
  const context = new Context();
  context.provide("connection", connection);
  context.provide("typert", { remotes: { register: () => () => {} } });
  const snapshotStore = initial => {
    let current = initial; const listeners = new Set();
    return { getSnapshot: () => current, set: value => { current = value; for (const fn of listeners) fn(); },
      subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); } };
  };
  const { InputTriggerService } = await loadClientBundle(inputBundle, {
    "@deepseek-ai/dsh-client-store": { createSnapshotStore: snapshotStore },
    "react/jsx-runtime": {}, react: {}, "@deepseek-ai/dsh-client-ui-primitives": {},
  });
  const session = { sessionId: "verify" }, binding = { sessionId: "verify", session, ctx: context };
  context.provide("sessions", { sessionOf: () => session, binding: id => id === "verify" ? binding : undefined,
    list: { getSnapshot: () => ({ byId: { verify: { title: "Verify conversation" } } }) } });
  const draftState = { draft: "Existing text", draftRev: 1, phase: "plain", attachmentIds: [] };
  const projection = { detectText: draftState.draft };
  context.provide("conversation", { input: { shell: () => ({ projection, state: { getSnapshot: () => draftState }, actions: {
    insertText(text, span) { assert.equal(span.start, projection.detectText.length); draftState.draft += text; projection.detectText += text; draftState.draftRev++; return true; },
    persistDraft() {}, submit() { assert.fail("draft insertion cannot submit a model message"); },
  } }) } });
  let annotationSlot;
  context.provide("slots", { inject: (_name, factory) => factory(), register: (definition, component) => { annotationSlot = { definition, component }; } });
  new InputTriggerService(context);
  const service = context.get("inputTriggers"); const sources = service.live.sources;
  const referenceItems = ["file", "folder", "session"].flatMap(kind => Array.from({ length: 9 }, (_, index) => ({ name: `${kind}-${index}`, section: kind,
    value: JSON.stringify({ kind: kind === "folder" ? "file" : kind, ...(kind === "folder" ? { fileKind: "directory" } : {}), mention: `@${kind}-${index}` }) })));
  const originalCandidates = async () => referenceItems;
  const nativeReference = { trigger: "@", name: "reference", candidates: originalCandidates,
    onPick: ({ candidate }) => ({ insert: { source: "reference", ref: JSON.parse(candidate.value).mention } }) };
  service.registerSource(nativeReference);
  gateway.apply(context);
  const fiber = context.plugin({ name: PACKAGE, inject: built.inject, apply: ctx => built.apply(ctx) });
  await fiber.await();
  assert.ok(context.remote.browserTabs, "the built client must mount remote.browserTabs");
  assert.equal(annotationSlot?.definition.name, "conversation.input.overlay");
  annotationSlot.component(annotationSlot.definition.inject("verify"));
  await new Promise(resolve => setTimeout(resolve, 0));
  const activation = calls.find(call => call.endpoint === "browserTabs/annotationSession").args.request;
  assert.equal(activation.sessionId, "verify"); assert.equal(activation.title, "Verify conversation"); assert.equal(activation.active, true);
  assert.match(draftState.draft, /^Existing text\n\nFix this button/);
  for (const cleanup of cleanups) cleanup?.();
  await new Promise(resolve => setTimeout(resolve, 0));
  const deactivation = calls.filter(call => call.endpoint === "browserTabs/annotationSession").at(-1).args.request;
  assert.equal(deactivation.active, false); assert.ok(deactivation.revision > activation.revision);
  assert.deepEqual(deactivation.acknowledgements, [{ id: "verify-note" }]);
  const source = sources.find(candidate => candidate.name === "browser-tabs");
  assert.ok(source, "the built client must register its @ source");
  const items = await source.candidates({ sessionId: "verify" }, { query: "", quoted: false, drilled: false });
  assert.equal(items.length, 1, JSON.stringify(items));
  assert.equal(items[0].name, "Example");
  const controller = service.sessionOf(context); let revision = 0;
  const guard = { tier: "free" };
  context.on("slash/input-insert-text", ({ text }) => {
    queueMicrotask(() => controller.track(text, text.length, guard, ++revision)); return true;
  });
  const waitMenu = async predicate => {
    for (let index = 0; index < 100; index++) {
      const menu = controller.menu.getSnapshot();
      if (predicate(menu)) return menu;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw new Error("The real DSH controller did not settle the reference group");
  };
  const referenceRows = state => state.groups.find(group => group.source === "reference")?.items || [];
  controller.track("@", 1, guard, revision);
  const collapsed = await waitMenu(state => state.open && referenceRows(state).length === 12);
  const expand = referenceRows(collapsed).findIndex(item => item.name === "展开文件（9）");
  controller.pick("reference", expand, "pick");
  const files = await waitMenu(state => state.open && state.hit.query === "文件:" && referenceRows(state).length === 10);
  assert.equal(referenceRows(files)[0].name, "收起文件");
  assert.equal(stateReadyItems(files, "browser-tabs").length, 0);
  controller.pick("reference", 0, "pick");
  await waitMenu(state => state.open && state.hit.query === "" && referenceRows(state).length === 12);
  assert.equal(controller.drilled, false);
  controller.pick("reference", expand, "drill");
  await waitMenu(state => state.open && state.hit.query === "文件:" && referenceRows(state).length === 10);
  controller.pick("reference", 0, "pick");
  const rootMenu = await waitMenu(state => state.open && state.hit.query === "" && referenceRows(state).length === 12);
  assert.equal(controller.drilled, false);
  controller.pick("reference", referenceRows(rootMenu).findIndex(item => item.name === "展开文件夹（9）"), "pick");
  const folders = await waitMenu(state => state.open && state.hit.query === "文件夹:" && referenceRows(state).length === 10);
  assert.equal(referenceRows(folders)[0].name, "收起文件夹");
  assert.equal(referenceRows(folders).filter(item => JSON.parse(item.value).fileKind === "directory").length, 9);
  controller.pick("reference", 0, "pick");
  await waitMenu(state => state.open && state.hit.query === "" && referenceRows(state).length === 12);
  assert.equal(controller.drilled, false);
  controller.dismiss();
  // Sources registered after this plugin must still be invoked. The installed
  // controller calls .then() directly on every candidates() result.
  for (const name of ["command", "context", "skills"]) service.registerSource({
    trigger: "/", name, async candidates() { return [{ name: `${name}-item`, value: name }]; },
    onPick: () => ({ text: "" }),
  });
  for (const text of ["/", "/apps", "/unmatched"]) {
    assert.doesNotThrow(() => controller.track(text, text.length, guard, ++revision),
      "slash candidate sources must return Promises so later sources can load");
    const slash = await waitMenu(state => state.open && ["command", "context", "skills"].every(name => stateReadyItems(state, name).length === 1));
    assert.ok(slash.groups.every(group => group.status !== "pending"), "no slash group should remain a loading skeleton");
    controller.dismiss();
  }
  await fiber.dispose();
  assert.equal(nativeReference.candidates, originalCandidates, "unload restores the native reference source");
  await context.fiber.dispose();
  console.log("PASS: built client lists tabs and publishes active conversation lifecycle; the real DSH registry/controller expands and collapses references, settles all slash sources, and restores references on unload.");
}

function stateReadyItems(state, name) { return state.groups.find(group => group.source === name)?.items || []; }

async function verifyNativeReferenceSource(bundle, searchBundle) {
  const native = await loadClientBundle(bundle, { react: {}, "react/jsx-runtime": {}, "@deepseek-ai/dsh-client-ui-primitives": {} });
  const sources = [], lookups = [];
  const service = { live: { sources }, registerSource(source) { sources.push(source); return () => {}; } };
  const binding = { session: { getSnapshot: () => ({ openState: "open" }) } };
  const sessions = { binding: () => binding, using: (_id, _options, callback) => callback({ binding }), list: { getSnapshot: () => ({ byId: {} }) } };
  const items = Array.from({ length: 7 }, (_, i) => ({ kind: "file", path: `src/file-${i}.js` }))
    .concat(Array.from({ length: 7 }, (_, i) => ({ kind: "directory", path: `dir-${i}` })));
  const context = {
    effect: factory => factory(), locale: { register() {}, bind: () => key => key },
    uiConversation: { userText: { register() {} } }, slots: { inject() {} },
    get: name => name === "sessions" ? sessions : name === "inputTriggers" ? service : undefined,
    remote: { $host: { home: "/home/test" },
      fileReferences: { list: async (_id, query) => { lookups.push(query); return { ok: true, value: query ? [] : items }; } },
      sessionReferenceResolver: { candidates: async () => ({ ok: true, value: [] }) } },
  };
  native.apply(context);
  const restore = compactReferences(service), source = sources.find(value => value.name === "reference");
  const session = { sessionId: "verify" }, request = query => ({ query, signal: new AbortController().signal });
  for (const query of ["文件", "文件:", "files", "文件："]) {
    const files = await source.candidates(session, request(query));
    assert.equal(files.length, 8); assert.equal(lookups.at(-1), "");
    assert.equal(source.onPick({ candidate: files[1], action: "pick" }).insert.ref, "@src/file-0.js");
  }
  const folders = await source.candidates(session, request("文件夹"));
  assert.equal(folders.length, 8);
  assert.deepEqual(source.onPick({ candidate: folders[1], action: "drill" }), { text: "@dir-0/", continue: true });
  const rootItems = await source.candidates(session, request(""));
  assert.equal(rootItems.filter(item => JSON.parse(item.value).fileKind === "file").length, 3);
  assert.equal(rootItems.find(item => JSON.parse(item.value).fileKind === "file").section, "文件");
  restore();
  console.log("PASS: the installed native file source lists actual file/folder candidate shapes, accepts @file aliases, and preserves native file insertion/folder navigation.");

  // Only the provider's registration/schema dependencies are stubbed. Its
  // actual exported WorkspaceFileSearch runs unchanged against a real tree.
  const chain = { step() { return this; }, min() { return this; }, default() { return this; } };
  const schema = { object: value => value, number: () => chain, string: () => chain, array: () => chain };
  const stubs = { "@deepseek-ai/schemastery": { __esModule: true, default: schema },
    "@deepseek-ai/dsh-file-reference": { __esModule: true, default: class {}, FILE_REFERENCE_PROMPT: "" },
    "@deepseek-ai/dsh-file-reference/grammar": {} };
  const require = createRequire(import.meta.url), module = { exports: {} };
  const compiled = await transform(await readFile(searchBundle, "utf8"), { format: "cjs", platform: "node" });
  new Function("require", "module", "exports", compiled.code)(id => stubs[id] ?? require(id), module, module.exports);
  const { WorkspaceFileSearch, DEFAULT_FILE_SEARCH_EXCLUDED_DIRECTORIES } = module.exports;
  const fixtureRoot = path.join(output, "file-limit-workspace");
  await mkdir(fixtureRoot, { recursive: true });
  for (let i = 0; i < 25; i++) await mkdir(path.join(fixtureRoot, `dir-${i}`), { recursive: true });
  for (const name of ["README.md", "LICENSE"]) await writeFile(path.join(fixtureRoot, name), "fixture");
  const config = { maxResults: 20, maxEntries: 50000, excludedDirectories: DEFAULT_FILE_SEARCH_EXCLUDED_DIRECTORIES };
  const search = new WorkspaceFileSearch(fixtureRoot, config);
  try {
    const limited = await search.list("", new AbortController().signal);
    assert.equal(limited.length, 20); assert.equal(limited.every(item => item.kind === "directory"), true, "reproduce native file starvation before the fix");
    const agent = {}, host = { config, list: (_agent, query, signal) => search.list(query, signal) };
    const restoreHost = balanceFileReferences(host, { ensure: async () => fixtureRoot });
    context.remote.fileReferences.list = async (_id, query, signal) => ({ ok: true, value: await host.list(agent, query, signal) });
    const restoreClient = compactReferences(service);
    try {
      const bare = await source.candidates(session, request(""));
      assert.equal(bare[0].section, "文件");
      assert.deepEqual(bare.filter(item => JSON.parse(item.value).fileKind === "file").map(item => item.name), ["LICENSE", "README.md"]);
      assert.equal((await host.list(agent, "", new AbortController().signal)).length, 20, "total native result budget stays bounded");
      const files = await source.candidates(session, request("文件"));
      assert.equal(source.onPick({ candidate: files[1], action: "pick" }).insert.source, "reference");
    } finally { restoreClient(); restoreHost(); }
  } finally { search.dispose(); }
  console.log("PASS: the installed native filesystem provider reproduces the 20-directory starvation; the host/client fix restores files in bare @ while retaining native insertion and the result budget.");
}

const bundles = await extract([
  "dsh-api-gateway/lib/client.js",
  "dsh-typert-registry/lib/index.js",
  "dsh-client-ui-input-trigger/lib/client.js",
  "dsh-client-ui-reference/lib/client.js",
  "dsh-file-reference-local/lib/index.js",
  "dsh-client-ui-conversation/lib/client.js",
]);
await verifyRegistry(bundles.get("dsh-typert-registry/lib/index.js"));
await verifyGateway(bundles.get("dsh-api-gateway/lib/client.js"));
await verifyBuiltClient(bundles.get("dsh-api-gateway/lib/client.js"), bundles.get("dsh-client-ui-input-trigger/lib/client.js"));
await verifyNativeReferenceSource(bundles.get("dsh-client-ui-reference/lib/client.js"), bundles.get("dsh-file-reference-local/lib/index.js"));
await verifyDraftInput(bundles.get("dsh-client-ui-conversation/lib/client.js"), root);
console.log(`\nAll DSH contract checks passed against ${path.basename(archive)}.`);
