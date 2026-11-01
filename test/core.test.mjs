import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tabRef, parseRef, formatMention, mentions, canControl, descriptors } from "../src/protocol.js";
import { sameSecret, extensionId, BrowserBridge } from "../src/bridge.js";
import { Pairings, pinnedExtensionId } from "../src/pairing.js";
import { Grants } from "../src/grants.js";
import { BrowserEngine, pageChunk } from "../src/engine.js";
import { apply as applyClient, inject } from "../src/client.js";

/** The HTML escaping the setup page applies to attribute values. */
function escapeAttribute(value) {
  return String(value).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/** File contents of a directory tree, for "nothing was written" assertions. */async function snapshotDirectory(directory, prefix = "") {
  const files = new Map();
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) for (const [key, value] of await snapshotDirectory(path.join(directory, entry.name), name)) files.set(key, value);
    else if (entry.isFile()) files.set(name, await readFile(path.join(directory, entry.name), "utf8"));
  }
  return files;
}

test("tab identities round-trip and mentions cannot change Markdown structure", () => {
  const ref = tabRef("abc-123", 42);
  assert.deepEqual(parseRef(ref), { profile: "abc-123", tabId: 42 });
  assert.deepEqual(mentions(formatMention({ title: "x](malicious)\n", ref })), [ref]);
  assert.ok(formatMention({ title: "x".repeat(60000), ref }).length < 180);
  assert.throws(() => parseRef("dsh-browser://abc/-1"));
  assert.throws(() => tabRef("bad/profile", 42));
  assert.equal(canControl("edge://settings"), false);
  assert.equal(canControl("https://example.com"), true);
  assert.equal(canControl("file:///D:/downloads/weather.html"), true);
  assert.equal(canControl("javascript:alert(1)"), false);
  assert.equal(sameSecret("x", "xy"), false);
  assert.equal(sameSecret("xy", "xy"), true);
  assert.match(extensionId(Buffer.from("test").toString("base64")), /^[a-p]{32}$/);
});

test("Remote descriptors carry strict codecs the DSH client gateway mounts", () => {
  // Mirrors api-gateway/lib/client.js requireStrictInputs(): a contribution with
  // an src-json parameter codec is refused, so `ctx.remote.browserTabs` never
  // exists and every menu entry degrades to "服务不可用".
  const strict = codec => codec.mode === "strict" && typeof codec.typeSymbol === "string"
    && codec.typeSymbol.length > 0 && typeof codec.create === "function"
    && typeof codec.create().parse === "function";
  assert.equal(descriptors.length, 7);
  for (const descriptor of descriptors) {
    assert.match(descriptor.id, /^dsh-doyourweb#browserTabs\/(list|setup|focus|apps|annotationSession|manage|diagnostics)$/);
    assert.equal(descriptor.invocation.kind, "direct");
    assert.deepEqual(descriptor.cancellation, { parameter: "signal" });
    assert.ok(strict(descriptor.result), `${descriptor.method} result needs a strict codec`);
    for (const parameter of descriptor.parameters) {
      assert.equal(parameter.wire, "request");
      assert.equal(parameter.source, "json");
      assert.ok(strict(parameter.codec), `${descriptor.method} parameter needs a strict codec`);
    }
  }
  const byMethod = new Map(descriptors.map(descriptor => [descriptor.method, descriptor]));
  const parse = (method, value) => byMethod.get(method).parameters[0].codec.create().parse(value);
  assert.deepEqual(parse("list", { query: "docs" }), { query: "docs" });
  assert.deepEqual(parse("list", {}), {});
  assert.deepEqual(parse("setup", {}), {});
  assert.deepEqual(parse("focus", { ref: "dsh-browser://abc/1" }), { ref: "dsh-browser://abc/1" });
  assert.throws(() => parse("focus", { ref: 1 }), /must be a string/);
  assert.throws(() => parse("focus", { referral: "x" }), /unexpected field/);
  assert.throws(() => parse("setup", []), /plain object/);
  assert.throws(() => parse("list", { query: "x", extra: true }), /unexpected field/);
  assert.deepEqual(byMethod.get("list").result.create().parse({ tabs: [], connected: false }),
    { tabs: [], connected: false });
});

test("the bridge never writes into the loadable extension folder", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dsh-extension-pin-"));
  const home = path.join(root, "bridge");
  const bridge = new BrowserBridge({ home, port: 43191 });
  try {
    // The shipped folder pins the id, so the user loads it as-is and nothing has
    // to be copied or rewritten per installation.
    const source = fileURLToPath(new URL("../extension", import.meta.url));
    const before = await snapshotDirectory(source);
    await bridge.start();
    assert.equal(bridge.extensionPath, source);
    assert.equal(bridge.id, pinnedExtensionId(JSON.parse(await readFile(path.join(source, "manifest.json"), "utf8"))));
    assert.deepEqual(await snapshotDirectory(source), before, "the extension folder must stay untouched");
    assert.equal(bridge.trustedOrigin(`chrome-extension://${bridge.id}`), true);
    assert.equal(bridge.trustedOrigin("chrome-extension://someoneelse"), false);
    assert.equal(bridge.trustedOrigin("https://example.com"), false);
    // Only the token is stored, and it never travels to the browser as a file.
    const settings = JSON.parse(await readFile(path.join(home, "pairing.json"), "utf8"));
    assert.deepEqual(Object.keys(settings), ["token"]);
    assert.match(settings.token, /^[0-9a-f]{64}$/);
    assert.equal(await readFile(path.join(source, "config.js"), "utf8"), before.get("config.js"));
  } finally {
    await bridge.close();
    assert.equal(path.dirname(home), root);
    await rm(root, { recursive: true, force: true });
  }
});

test("pairing hands the token only to the request the user approved", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dsh-pairing-"));
  const bridge = new BrowserBridge({ home: path.join(root, "bridge"), port: 43192 });
  try {
    await bridge.start();
    const sent = [];
    const socket = { readyState: 1, send: message => sent.push(JSON.parse(message)), close: () => { socket.readyState = 3; }, on: () => {} };
    bridge.acceptPairing(socket);
    const challenge = sent[0];
    assert.equal(challenge.method, "dsh.pairing");
    assert.match(challenge.params.code, /^[0-9]{4}$/);
    assert.equal(challenge.params.port, bridge.port);
    assert.equal(bridge.pairings.list().length, 1);
    // Denying or approving a stale id must not hand out the token.
    assert.equal(bridge.approvePairing("stale"), false);
    assert.deepEqual(sent.length, 1);
    assert.equal(bridge.approvePairing(challenge.params.id), true);
    assert.equal(sent[1].method, "dsh.paired");
    assert.equal(sent[1].params.token, bridge.settings.token);
    assert.equal(socket.readyState, 3, "the pairing socket is closed so it never becomes a control channel");
    assert.equal(bridge.pairings.list().length, 0);
    assert.equal(bridge.approvePairing(challenge.params.id), false, "approval is single use");
    // Pairing saturates instead of queueing unbounded requests.
    for (let index = 0; index < 6; index++) bridge.acceptPairing({ readyState: 1, send: () => {}, close: () => {}, on: () => {} });
    assert.ok(bridge.pairings.list().length <= 4);
  } finally {
    await bridge.close();
    assert.equal(path.dirname(bridge.home), root);
    await rm(root, { recursive: true, force: true });
  }
});

test("the setup page serves the pairing request and refuses forged posts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dsh-setup-"));
  const bridge = new BrowserBridge({ home: path.join(root, "bridge"), port: 43193 });
  try {
    await bridge.start();
    const socket = { readyState: 1, send: () => {}, close: () => {}, on: () => {} };
    bridge.acceptPairing(socket);
    const response = await fetch(bridge.url);
    const page = await response.text();
    const policy = response.headers.get("content-security-policy");
    const request = bridge.pairings.list()[0];
    assert.match(page, new RegExp(request.code));
    assert.match(page, /\/setup\/pair/);
    // The folder path is a copy button, not a link: a browser refuses web-page
    // navigation to chrome://, so only the user can open the extension manager.
    assert.match(page, /<button type="button" class="copy" data-copy="[^"]+">/);
    assert.ok(page.includes(escapeAttribute(bridge.extensionPath)), "the page must hand out the folder the user loads");
    assert.ok(page.includes("edge://extensions") && page.includes("chrome://extensions"));
    assert.equal(/href="(chrome|edge):\/\//.test(page), false, "a chrome:// link would be dead weight");
    assert.match(policy, /script-src 'nonce-/);
    // The nonce is base64, so compare literally instead of building a regex.
    const nonce = policy.match(/script-src 'nonce-([^']+)'/)[1];
    assert.ok(page.includes(`<script nonce="${nonce}">`), "the page must carry the script nonce it was served with");
    assert.ok(page.includes(String(bridge.port)), "the page must name the port the extension needs");
    const pairEndpoint = new URL("setup/pair", bridge.url);
    // A cross-site post cannot approve anything, even with the right fields.
    const forged = await fetch(pairEndpoint, {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "Sec-Fetch-Site": "cross-site" },
      body: new URLSearchParams({ key: bridge.setupKey, id: request.id, action: "allow" }),
    });
    assert.equal(forged.status, 403);
    assert.equal(bridge.pairings.list().length, 1);
    // A wrong key is refused too.
    const guessed = await fetch(pairEndpoint, {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "Sec-Fetch-Site": "same-origin" },
      body: new URLSearchParams({ key: "nope", id: request.id, action: "allow" }),
    });
    assert.equal(guessed.status, 403);
    assert.equal(bridge.pairings.list().length, 1);
    // The page's own form approves the request.
    const approved = await fetch(pairEndpoint, {
      method: "POST", redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "Sec-Fetch-Site": "same-origin" },
      body: new URLSearchParams({ key: bridge.setupKey, id: request.id, action: "allow" }),
    });
    assert.equal(approved.status, 303);
    assert.equal(bridge.pairings.list().length, 0);
  } finally {
    await bridge.close();
    assert.equal(path.dirname(bridge.home), root);
    await rm(root, { recursive: true, force: true });
  }
});

test("pairing requests expire and unpaired sockets are forgotten", () => {
  let now = 1000;
  const pairings = new Pairings({ ttlMs: 50, now: () => now });
  const socket = {};
  const entry = pairings.request(socket);
  assert.equal(pairings.list().length, 1);
  now += 51;
  assert.deepEqual(pairings.list(), []);
  assert.equal(pairings.take(entry.id), undefined);
  const second = pairings.request({});
  pairings.drop(second.socket);
  assert.deepEqual(pairings.list(), []);
  assert.throws(() => pinnedExtensionId({}), /must pin a key/);
});

test("an expired pairing closes its socket so the extension can request a new code", () => {
  let now = 1000;
  let closed = false;
  const pairings = new Pairings({ ttlMs: 50, now: () => now });
  pairings.request({ close: () => { closed = true; } });
  now += 51;
  assert.deepEqual(pairings.list(), []);
  assert.equal(closed, true);
});

test("pagination is bounded, explicit, and lossless", () => {
  const snapshot = { id: "s1", text: "first\nsecond line\nthird\n" };
  let offset = 0, output = "";
  do {
    const chunk = pageChunk(snapshot, offset, 9);
    assert.ok(chunk.content.length <= 9);
    output += chunk.content;
    offset = chunk.cursor ? Number(chunk.cursor.split(":")[1]) : -1;
  } while (offset >= 0);
  assert.equal(output, snapshot.text);
  assert.throws(() => pageChunk(snapshot, -1));
});

function fixture() {
  let epoch = 1;
  const actions = [];
  const page = { evaluate: async () => ({ epoch, url: "https://example.com" }), title: async () => "Test",
    url: () => "https://example.com", locator: selector => ({
      ariaSnapshot: async () => '- button "Save" [ref=e1]\n- textbox "Name" [ref=e2]',
      click: async () => { if (selector === "aria-ref=e9") throw new Error("missing"); actions.push("click"); },
      fill: async text => { actions.push(text); },
    }), goto: async () => { actions.push("navigate"); epoch++; } };
  const bridge = { page: async () => page };
  return { engine: new BrowserEngine(bridge), actions, reload: () => epoch++ };
}

test("stale snapshot rejects before any action", async () => {
  const { engine, actions, reload } = fixture();
  const read = await engine.read("tab");
  reload();
  await assert.rejects(engine.act("tab", { snapshot: read.snapshot, steps: [{ op: "click", ref: "e1" }] }), /stale/);
  assert.deepEqual(actions, []);
});

test("read budgets include escaped content and long metadata without losing pagination", async () => {
  const url = `https://example.com/${"x".repeat(20000)}`;
  const text = '- paragraph: "<untrusted>"\n'.repeat(40);
  const page = { evaluate: async () => ({ epoch: 1, url }),
    title: async () => "x".repeat(60000), locator: () => ({ ariaSnapshot: async () => text }) };
  const engine = new BrowserEngine({ page: async () => page });
  let result = await engine.read("dsh-browser://runtime/7", { limit: 400 });
  assert.equal(result.metadataTruncated, true);
  let content = "";
  for (let index = 0; index < 50; index++) {
    assert.ok(JSON.stringify(result).replace(/</g, "\\u003c").length <= 400);
    content += result.content;
    if (!result.cursor) break;
    assert.ok(result.content.length > 0, "every cursor advances");
    result = await engine.read("dsh-browser://runtime/7", { limit: 400, cursor: result.cursor });
  }
  assert.equal(content, text);
});

test("iframe refs returned by Playwright are accepted without guessing selectors", async () => {
  const selected = [];
  const page = { evaluate: async () => ({ epoch: 1, url: "https://example.com" }),
    title: async () => "Frames", url: () => "https://example.com", locator: selector => ({
      ariaSnapshot: async () => '- iframe [ref=e1]:\n  - button "Save" [ref=f2e7]',
      click: async () => selected.push(selector),
    }) };
  const engine = new BrowserEngine({ page: async () => page });
  const initial = await engine.read("tab");
  const result = await engine.act("tab", { snapshot: initial.snapshot, steps: [{ op: "click", ref: "f2e7" }] });
  assert.equal(result.completed.length, 1, JSON.stringify(result));
  assert.deepEqual(selected, ["aria-ref=f2e7"]);
});

test("batch stops at failure and reports completed effects", async () => {
  const { engine, actions } = fixture();
  const read = await engine.read("tab");
  const result = await engine.act("tab", { snapshot: read.snapshot, steps: [
    { op: "fill", ref: "e2", value: "name" }, { op: "click", ref: "e9" }, { op: "click", ref: "e1" },
  ] });
  assert.deepEqual(actions, ["name"]);
  assert.equal(result.completed.length, 1);
  assert.equal(result.failure.index, 1);
  await assert.rejects(engine.act("tab", { snapshot: read.snapshot, steps: [{ op: "click", ref: "e1" }] }), /stale/);
});

test("wait and bounded extraction share a batch and summary skips another snapshot", async () => {
  let snapshots = 0;
  const waits = [];
  const controller = new AbortController();
  const page = { evaluate: async () => ({ epoch: 1, url: "https://example.com" }),
    title: async () => "Test", locator: () => ({
      ariaSnapshot: async () => { snapshots++; return '- button "Save" [ref=e1]'; },
      click: async () => {}, waitFor: async options => waits.push(options),
      evaluateAll: async (_fn, args) => {
        assert.deepEqual(args.fields, ["text", "href"]);
        return { rows: Array.from({ length: 20 }, () => ({ text: "<".repeat(200), href: "x".repeat(200) })),
          totalRows: 30, truncated: true };
      },
    }) };
  const engine = new BrowserEngine({ page: async () => page });
  const initial = await engine.read("tab");
  const result = await engine.act("tab", { snapshot: initial.snapshot, observe: "summary", steps: [
    { op: "click", ref: "e1" },
    { op: "wait", selector: ".results", state: "visible", timeout: 1500 },
    { op: "extract", selector: ".results a", fields: ["text", "href"], maxRows: 20 },
  ] }, controller.signal);
  assert.equal(result.completed.length, 3, JSON.stringify(result));
  assert.deepEqual(waits, [{ state: "visible", timeout: 1500, signal: controller.signal }]);
  assert.equal(result.results[0].index, 2);
  assert.ok(result.results[0].rows.length > 0);
  assert.ok(result.results[0].omittedRows > 0);
  assert.ok(JSON.stringify(result).replace(/</g, "\\u003c").length <= 1600);
  assert.equal(snapshots, 1);
  assert.equal(result.snapshot, undefined);
  await assert.rejects(engine.act("tab", { snapshot: initial.snapshot, steps: [{ op: "click", ref: "e1" }] }), /stale/);
});

test("batch stops after navigation; old cursor and cancelled calls cannot act", async () => {
  const { engine, actions } = fixture();
  const read = await engine.read("tab");
  const result = await engine.act("tab", { snapshot: read.snapshot, steps: [
    { op: "navigate", value: "https://example.org" }, { op: "click", ref: "e1" },
  ] });
  assert.equal(result.navigated, true);
  assert.deepEqual(actions, ["navigate"]);
  await assert.rejects(engine.read("tab", { cursor: `${read.snapshot}:0` }), /stale/);
  await assert.rejects(engine.read("tab", {}, AbortSignal.abort()), /abort/i);
});

test("cancellation after an effect reports it and never leaves the old snapshot usable", async () => {
  const controller = new AbortController();
  const actions = [];
  const page = { evaluate: async () => ({ epoch: 1, url: "https://example.com" }),
    title: async () => "Test", url: () => "https://example.com", locator: () => ({
      ariaSnapshot: async () => '- button "Submit" [ref=e1]',
      click: async options => { actions.push("submit"); assert.equal(options.signal, controller.signal); controller.abort(); },
    }) };
  const engine = new BrowserEngine({ page: async () => page });
  const initial = await engine.read("tab");
  const interrupted = await engine.act("tab", { snapshot: initial.snapshot, steps: [
    { op: "click", ref: "e1" }, { op: "click", ref: "e1" },
  ] }, controller.signal);
  assert.equal(interrupted.cancelled, true);
  assert.deepEqual(interrupted.completed, [{ index: 0, op: "click" }]);
  assert.deepEqual(actions, ["submit"]);
  await assert.rejects(engine.act("tab", { snapshot: initial.snapshot, steps: [{ op: "click", ref: "e1" }] }), /stale/i);
  const current = await engine.read("tab");
  assert.deepEqual(current.lastAction.completed, [0]);
  assert.equal(current.lastAction.cancelled, true);
});

test("an in-flight cancellation preserves completed steps and marks the uncertain effect", async () => {
  const controller = new AbortController();
  let clicks = 0;
  const page = { evaluate: async () => ({ epoch: 1, url: "https://example.com" }),
    title: async () => "Test", locator: () => ({
      ariaSnapshot: async () => '- button "Submit" [ref=e1]',
      fill: async () => {},
      click: options => new Promise((_resolve, reject) => {
        clicks++;
        assert.equal(options.signal, controller.signal);
        options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
        controller.abort();
      }),
    }) };
  const engine = new BrowserEngine({ page: async () => page });
  const initial = await engine.read("tab");
  const result = await engine.act("tab", { snapshot: initial.snapshot, steps: [
    { op: "fill", ref: "e1", value: "name" }, { op: "click", ref: "e1" }, { op: "click", ref: "e1" },
  ] }, controller.signal);
  assert.deepEqual(result.completed, [{ index: 0, op: "fill" }]);
  assert.equal(result.uncertainStep, 1);
  assert.equal(result.mayHaveLateEffects, true);
  assert.equal(clicks, 1);
  const recovery = await engine.read("tab", { limit: 400 });
  assert.equal(recovery.lastAction.uncertainStep, 1);
  assert.deepEqual(recovery.lastAction.completed, [0]);
  assert.ok(JSON.stringify(recovery).length <= 400);
});

test("already cancelled calls never acquire the browser", async () => {
  let attached = 0;
  const engine = new BrowserEngine({ page: async () => { attached++; throw new Error("must not acquire"); } });
  const signal = AbortSignal.abort();
  await assert.rejects(engine.read("tab", {}, signal), /abort/i);
  await assert.rejects(engine.act("tab", { snapshot: "old", steps: [] }, signal), /abort/i);
  await assert.rejects(engine.capture("tab", {}, signal), /abort/i);
  assert.equal(attached, 0);
});

test("conversation grants accumulate, stay bounded, and survive a restart", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dsh-grants-"));
  const file = path.join(root, "authorized.json");
  try {
    const grants = new Grants({ file });
    await grants.load();
    assert.equal(grants.get("s1").size, 0);
    // DSH claims one batch per step; a step whose batch carries no user message
    // must not revoke what the conversation already cited.
    assert.equal(await grants.allow("s1", ["dsh-browser://abc/1", "dsh-browser://abc/1"]), true);
    assert.equal(await grants.allow("s1", []), false);
    assert.deepEqual([...grants.get("s1")], ["dsh-browser://abc/1"]);
    assert.equal(await grants.allow("s1", ["nonsense", "dsh-browser://abc/2"]), true);
    assert.deepEqual([...grants.get("s1")], ["dsh-browser://abc/1", "dsh-browser://abc/2"]);
    const reopened = new Grants({ file });
    await reopened.load();
    assert.deepEqual([...reopened.get("s1")], ["dsh-browser://abc/1", "dsh-browser://abc/2"]);
    assert.equal(reopened.get("other").size, 0);

    const bounded = new Grants({ file: path.join(root, "bounded.json"), perSession: 2, sessions: 2 });
    await bounded.load();
    await bounded.allow("a", ["dsh-browser://p/1", "dsh-browser://p/2", "dsh-browser://p/3"]);
    assert.deepEqual([...bounded.get("a")], ["dsh-browser://p/2", "dsh-browser://p/3"]);
    await bounded.allow("b", ["dsh-browser://p/1"]);
    await bounded.allow("c", ["dsh-browser://p/1"]);
    assert.equal(bounded.get("a").size, 0, "the oldest conversation is dropped first");

    // A damaged file is reported but never blocks plugin activation.
    const reported = [];
    await writeFile(file, "{not json");
    const recovered = new Grants({ file, onError: error => reported.push(error.message) });
    await recovered.load();
    assert.equal(recovered.get("s1").size, 0);
    assert.equal(reported.length, 1);
  } finally {
    assert.equal(path.dirname(file), root);
    await rm(root, { recursive: true, force: true });
  }
});

test("client uses native @ source and synchronous slash command contract", async () => {
  const sources = [];
  const ctx = { effect: fn => fn(), inputTriggers: { registerSource: source => sources.push(source) },
    remote: { $mount: () => () => {}, browserTabs: { list: async () => ({ ok: true, value: { tabs: [
      { title: "Example", url: "https://example.com", ref: "dsh-browser://abc/1", browser: "Edge" },
    ] } }) } } };
  applyClient(ctx, { browserIcon: () => null, tabIcon: () => () => null });
  const items = await sources[0].candidates({}, { query: "" });
  assert.equal(items[0].section, "\u6807\u7b7e\u9875");
  const picked = sources[0].onPick({ candidate: items[0] });
  assert.equal(picked.insert.source, "browser-tabs");
  assert.deepEqual(mentions(await sources[0].codec.serialize(picked.insert.ref)), ["dsh-browser://abc/1"]);
  assert.deepEqual(await sources[0].candidates({}, { quoted: true }), []);
});

test("client resolves the Remote namespace Cordis refuses as an uninjected property", async () => {
  // Cordis resolves a Remote namespace as its own `remote.<namespace>` service.
  // Without that nested key in `inject`, `ctx.remote.browserTabs` throws
  // `cannot get property "remote.browserTabs" without inject`; declaring it would
  // deadlock a plugin that mounts the namespace itself. The client must therefore
  // read the namespace through `ctx.get()`, which also reports a readable reason
  // while the host half is missing.
  const service = { list: async () => ({ ok: true, value: { connected: true, tabs: [
    { title: "Example", url: "https://example.com", ref: "dsh-browser://abc/1", browser: "Edge" },
  ] } }) };
  const sources = [];
  const remote = new Proxy({ $mount: () => () => {} }, {
    get: (target, property) => {
      if (property === "$mount") return target.$mount;
      throw new Error(`cannot get property "remote.${String(property)}" without inject`);
    },
  });
  const ctx = { effect: fn => fn(), inputTriggers: { registerSource: source => sources.push(source) },
    remote, get: name => (name === "remote.browserTabs" ? service : undefined) };
  applyClient(ctx, { browserIcon: () => null, tabIcon: () => () => null });
  assert.deepEqual(inject, ["inputTriggers", "remote"]);
  assert.equal(inject.includes("remote.browserTabs"), false, "injecting the namespace this plugin mounts would deadlock activation");
  const items = await sources[0].candidates({}, { query: "" });
  assert.equal(items[0].name, "Example");
  ctx.get = () => undefined;
  const missing = await sources[0].candidates({}, { query: "" });
  assert.match(missing[0].description, /not registered by the DSH host/);
});

test("both menus show existing tabs with supported icons and preserve other sources", async () => {
  const BrowserIcon = () => null;
  const TabIcon = () => null;
  const builtin = { trigger: "/", name: "command" };
  const sources = [builtin];
  const tab = { title: "Example", url: "https://example.com", ref: "dsh-browser://abc/1", browser: "Edge" };
  const ctx = { effect: fn => fn(), inputTriggers: { registerSource: source => sources.push(source) },
    remote: { $mount: () => () => {}, browserTabs: { list: async () => ({ ok: true,
      value: { tabs: [tab], connected: true } }) } } };
  applyClient(ctx, { browserIcon: BrowserIcon, tabIcon: () => TabIcon });
  assert.equal(sources[0], builtin);
  for (const trigger of ["@", "/"]) {
    const source = sources.find(item => item.trigger === trigger && item !== builtin);
    const candidates = await source.candidates({}, { query: "" });
    const candidate = candidates.find(item => item.name === "Example");
    assert.ok(candidate, `${trigger} should include existing tabs`);
    assert.equal(candidate.icon, TabIcon);
    const picked = source.onPick({ candidate });
    assert.equal(picked.insert.source, "browser-tabs");
    assert.equal(picked.insert.appearance, "file");
    assert.deepEqual(mentions(picked.insert.ref), [tab.ref]);
  }
});

test("an offline browser or failed RPC exposes setup instead of an empty menu", async () => {
  const BrowserIcon = () => null;
  const sources = [], opened = [];
  let response = { ok: true, value: { connected: false, tabs: [] } };
  const ctx = { effect: fn => fn(), inputTriggers: { registerSource: source => sources.push(source) },
    remote: { $mount: () => () => {}, browserTabs: {
      list: async () => response,
      setup: async () => ({ ok: true, value: { url: "http://127.0.0.1:43187/setup" } }),
    } } };
  applyClient(ctx, { browserIcon: BrowserIcon, tabIcon: () => BrowserIcon });
  const originalWindow = globalThis.window;
  globalThis.window = { open: (...args) => opened.push(args) };
  try {
    for (const source of sources.filter(source => ["browser-tabs", "browser-setup"].includes(source.name))) {
      const items = await source.candidates({}, { query: "" });
      assert.equal(items.length, 1);
      assert.equal(items[0].icon, BrowserIcon);
      const picked = source.onPick({ candidate: items[0] });
      assert.deepEqual(picked, { text: "" });
      assert.equal(picked instanceof Promise, false, "DSH does not await onPick");
      await Promise.resolve();
    }
    assert.equal(opened.length, 2);
    response = { ok: false, error: { message: "Host disconnected" } };
    const failed = await sources[0].candidates({}, { query: "" });
    assert.match(failed[0].description, /Host disconnected/);
    assert.equal(failed[0].value, "setup");
    assert.deepEqual(await sources[0].candidates({}, { query: "", signal: AbortSignal.abort() }), []);
  } finally { globalThis.window = originalWindow; }
});

