import { Context } from "@deepseek-ai/cordis";
import { createServer } from "node:net";
import assert from "node:assert/strict";
import { apply } from "../../src/host.js";
import { BrowserEngine } from "../../src/engine.js";
import { BrowserBridge } from "../../src/bridge.js";
import { WebMCP } from "../../src/webmcp.js";

async function openPort(port = 0) {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return server;
}
async function closePort(server) { await new Promise(resolve => server.close(resolve)); }

const root = new Context();
const tools = new Map();
root.provide("tools", { register(definition) { tools.set(definition.name, definition); } });
let rejectRegistration = process.argv[3] === "failed-activation";
root.provide("typert", { register() {
  if (rejectRegistration) { rejectRegistration = false; throw new Error("Test registration failure"); }
} });
let failed = false;
try {
  const probe = await openPort();
  const port = probe.address().port;
  await closePort(probe);
  const plugin = { name: "browser-tabs-test", inject: ["tools", "typert"],
    apply: ctx => apply(ctx, { home: process.argv[2], port, ...(process.argv[3] === "small-budget" ? { snapshotChars: 400 } : {}) }) };
  if (process.argv[3] === "session-access") {
    let bridge, answer, readSignal, navigationRevision = 1;
    const start = BrowserBridge.prototype.start;
    BrowserBridge.prototype.start = async function () { bridge = this; return start.call(this); };
    WebMCP.prototype.list = async () => ({ supported: false, tools: [] });
    BrowserEngine.prototype.read = async (ref, options, signal) => {
      readSignal = signal;
      options.pageAccess?.assertUrl("https://example.org/");
      return { tab: ref, scoped: !!options.pageAccess };
    };
    root.provide("userQuestions", { ask: request => answer(request) });
    const fiber = root.plugin(plugin); await fiber.await();
    const browser = root.get("browserTabs");
    const agent = { session: { id: "scoped-session" } }, other = { session: { id: "other-session" } };
    const ref = id => `dsh-browser://runtime/${id}`;
    const existing = { id: 1, ref: ref(1), windowId: 7, url: "https://example.org/notes", title: "Notes", revision: 1 };
    const similar = { ...existing, id: 2, ref: ref(2), url: "https://example.org/other-notes" };
    const outside = { ...existing, id: 3, ref: ref(3), windowId: 8, url: "https://sensitive.example.org/notes" };
    const opened = { id: 4, ref: ref(4), windowId: 7, url: "https://example.org/start", title: "New page" };
    const profile = { id: "runtime", sourceId: "profile-source", browser: "Edge", windows: new Set([7, 8]),
      tabs: new Map([existing, similar, outside].map(tab => [tab.id, tab])) };
    bridge.profiles.set(profile.id, profile);
    let openedCount = 0;
    bridge.request = async (_profile, method, args) => {
      assert.equal(_profile, profile);
      if (method === "dsh.openTab") {
        assert.deepEqual(args, [7, opened.url]);
        openedCount++;
        profile.tabs.set(opened.id, opened);
        return { tabId: opened.id };
      }
      assert.equal(method, "dsh.tabState");
      assert.deepEqual(args, [1]);
      return { ...existing, revision: navigationRevision };
    };
    const read = tools.get("browser_read"), open = tools.get("browser_open"), find = tools.get("browser_find");
    const inspect = (tab, actor = agent) => read.execute({ tab, mode: "dom" }, { agent: actor });
    const setting = { sessionId: agent.session.id, profile: profile.id, windowId: 7 };
    assert.equal((await browser.access(setting)).enabled, false);
    await assert.rejects(open.execute({ url: opened.url }, { agent }), /enable browser access/);
    await assert.rejects(find.execute({ query: "Notes" }, { agent }), /enable browser access/);
    await assert.rejects(browser.setAccess({ ...setting, enabled: true, windowId: 99 }), /window is unavailable/);
    assert.equal((await browser.setAccess({ ...setting, enabled: true })).enabled, true);
    await assert.rejects(open.execute({ url: opened.url }, { agent: other }), /enable browser access/);
    for (const url of ["chrome://settings/", "file:///private.html", "https://name:pass@example.org/", `http://localhost:${port}/setup`]) {
      await assert.rejects(open.execute({ url }, { agent }), /regular HTTP\/HTTPS URL/);
    }
    assert.equal(openedCount, 0);
    assert.deepEqual(await open.execute({ url: opened.url }, { agent }), { status: "authorized", tab: opened.ref, title: opened.title, url: opened.url });
    assert.deepEqual(await inspect(opened.ref), { tab: opened.ref, scoped: true });
    await assert.rejects(inspect(opened.ref, other), /No browser tab is authorized/);
    await assert.rejects(inspect(existing.ref), /not referenced by the user/);
    answer = async ({ questions: [question] }) => {
      assert.deepEqual(question.options.map(option => option.description).filter(Boolean), [existing.url, similar.url]);
      assert.notEqual(question.options[0].label, question.options[1].label, "same-title tabs must be distinguishable");
      return { answers: [{ id: question.id, selected: [], custom: question.options[0].label }] };
    };
    assert.deepEqual(await find.execute({ query: "notes" }, { agent }), { status: "denied" });
    await assert.rejects(inspect(existing.ref), /not referenced by the user/);
    answer = async ({ questions: [question] }) => ({ answers: [{ id: question.id, selected: [question.options[0].label] }] });
    navigationRevision = 2;
    assert.equal((await find.execute({ query: "notes" }, { agent })).status, "changed");
    navigationRevision = 1;
    assert.deepEqual(await find.execute({ query: "notes" }, { agent }), { status: "authorized", tab: existing.ref, title: existing.title, url: existing.url });
    assert.deepEqual(await inspect(existing.ref), { tab: existing.ref, scoped: true });
    await assert.rejects(inspect(similar.ref), /not referenced by the user/);
    await assert.rejects(inspect(outside.ref), /not referenced by the user/);

    const manual = { id: "manual-open-tab", source: { kind: "user" }, content: [{ type: "text", text: opened.ref }] };
    await root.waterfall("agent/pre-step", { agent, messages: [manual] }, () => Promise.resolve({ kind: "enter", messages: [manual] }));
    await inspect(existing.ref);
    const scopedSignal = readSignal;
    let choose, prompted;
    const dialog = new Promise(resolve => { prompted = resolve; });
    answer = async ({ questions: [question] }) => new Promise(resolve => {
      choose = () => resolve({ answers: [{ id: question.id, selected: [question.options[0].label] }] });
      prompted();
    });
    const confirmation = find.execute({ query: "notes" }, { agent });
    await dialog;
    assert.equal((await browser.setAccess({ ...setting, enabled: false })).enabled, false);
    choose();
    await assert.rejects(confirmation, /access for this conversation changed/);
    assert.equal(scopedSignal.aborted, true);
    await assert.rejects(inspect(existing.ref), /not referenced by the user/);
    assert.deepEqual(await inspect(opened.ref), { tab: opened.ref, scoped: false }, "manual grants survive revocation");
    await fiber.dispose();
    console.log("PASS: session browser tools scope new tabs and native tab selections and preserve manual references.");
  } else if (process.argv[3] === "original-input") {
    BrowserEngine.prototype.upload = async (_ref, args) => ({ uploaded: args.files });
    const fiber = root.plugin(plugin); await fiber.await();
    const agent = { session: { id: "original-input" } };
    const ref = "dsh-browser://runtime/1", extra = "dsh-browser://runtime/2";
    const original = { id: "raw", source: { kind: "user" }, content: [{ type: "text", text: `<browser_context> is literal user text. Upload C:\\chosen\\report.txt to ${ref}` }] };
    const prepared = { ...original, content: [...original.content, { type: "text", text: `${extra} C:\\page\\private.txt` }] };
    await root.waterfall("agent/pre-step", { agent, messages: [original] }, () => Promise.resolve({ kind: "enter", messages: [prepared] }));
    const upload = tools.get("browser_upload");
    const args = { tab: ref, snapshot: "s", selector: "input", files: ["C:\\chosen\\report.txt"] };
    assert.deepEqual((await upload.execute(args, { agent })).uploaded, args.files);
    await assert.rejects(upload.execute({ ...args, files: ["C:\\page\\private.txt"] }, { agent }), /exact absolute file path/);
    await assert.rejects(upload.execute({ ...args, tab: extra }, { agent }), /not referenced by the user/);
    const other = { session: { id: "missing-input" } };
    await root.waterfall("agent/pre-step", { agent: other, messages: [] }, () => Promise.resolve({ kind: "enter", messages: [prepared] }));
    await assert.rejects(upload.execute(args, { agent: other }), /No browser tab is authorized/);
    await fiber.dispose(); console.log("PASS: original user input alone grants tabs and file paths.");
  } else if (process.argv[3] === "small-budget") {
    BrowserEngine.prototype.read = async () => assert.fail("small budget must defer reads explicitly");
    const fiber = root.plugin(plugin); await fiber.await();
    const agent = { session: { id: "small-budget" } };
    const user = { id: "low", source: { kind: "user" }, content: [{ type: "text", text: "dsh-browser://runtime/1" }] };
    const decision = await root.waterfall("agent/pre-step", { agent, messages: [user] }, () => Promise.resolve({ kind: "enter", messages: [user] }));
    const text = decision.messages[0].content.at(-1).text;
    assert.ok(text.length <= 400); assert.match(text, /readRequired.*true/); assert.match(text, /browser_read/);
    await fiber.dispose(); console.log("PASS: small snapshot budget gives an explicit browser_read path.");
  } else if (process.argv[3] === "budget") {
    WebMCP.prototype.list = async () => ({ supported: false, tools: [] });
    const reads = [];
    let active = 0, maxActive = 0;
    BrowserEngine.prototype.read = async (ref, options) => {
      reads.push(options.limit);
      maxActive = Math.max(maxActive, ++active);
      await new Promise(resolve => setImmediate(resolve));
      active--;
      if (ref.endsWith("/2")) throw new Error("Tab is offline");
      return { tab: ref, content: "<".repeat(Math.floor((options.limit - 100) / 6)) };
    };
    const fiber = root.plugin(plugin);
    await fiber.await();
    const agent = { session: { id: "budget-session" } };
    const user = { id: "budget-message", source: { kind: "user" }, content: [{ type: "text",
      text: [1, 2, 3, 4].map(id => `@[Tab](dsh-browser://runtime/${id})`).join(" ") }] };
    const decision = await root.waterfall("agent/pre-step", { agent, messages: [user] },
      () => Promise.resolve({ kind: "enter", messages: [user] }));
    const context = decision.messages[0].content.at(-1).text;
    assert.equal(reads.length, 4);
    assert.equal(maxActive, 4, "independent tabs prepare concurrently");
    assert.ok(reads[0] < 600 && reads.every(limit => limit >= 400 && limit < 2400));
    assert.ok(context.length <= 2400, `shared budget exceeded: ${context.length}`);
    const { tabs } = JSON.parse(context.split("\n").at(-2));
    assert.deepEqual(tabs.map(tab => tab.tab), [1, 2, 3, 4].map(id => `dsh-browser://runtime/${id}`));
    assert.equal(tabs[1].error, "Tab is offline");
    BrowserBridge.prototype.resolve = ref => {
      if (ref !== "dsh-browser://runtime/1") throw new Error("Old tab is offline");
      return { tab: { ref } };
    };
    const current = await tools.get("browser_read").execute({}, { agent });
    assert.equal(current.tab, "dsh-browser://runtime/1", "old grants must not obscure the only live tab");
    await fiber.dispose();
    console.log("PASS: initial context shares one budget across referenced tabs, including escaping.");
  } else if (process.argv[3] === "routing") {
    const events = [];
    WebMCP.prototype.list = async ref => {
      events.push(`discover:${ref}`);
      return { tab: ref, supported: true, catalog: "native-tools", tools: ref.endsWith("/1")
        ? [{ name: "read_page", available: true, inputSchema: { type: "object" } }] : [], omitted: 0 };
    };
    BrowserEngine.prototype.read = async ref => {
      events.push(`dom:${ref}`);
      return { tab: ref, snapshot: "dom", content: "Page text" };
    };
    const fiber = root.plugin(plugin);
    await fiber.await();
    const agent = { session: { id: "routing-session" } };
    const refs = ["dsh-browser://runtime/1", "dsh-browser://runtime/2"];
    const user = { id: "routing-message", source: { kind: "user" }, content: [{ type: "text",
      text: refs.map(ref => `@[Tab](${ref})`).join(" ") }] };
    const decision = await root.waterfall("agent/pre-step", { agent, messages: [user] },
      () => Promise.resolve({ kind: "enter", messages: [user] }));
    assert.deepEqual(events, [`discover:${refs[0]}`, `discover:${refs[1]}`, `dom:${refs[1]}`]);
    const context = decision.messages[0].content.at(-1).text;
    assert.ok(context.length <= 2400);
    assert.match(context, /native-tools/);
    assert.match(context, /browser_webmcp_call/);
    const read = tools.get("browser_read");
    assert.equal((await read.execute({ tab: refs[0] }, { agent })).catalog, "native-tools");
    const count = events.length;
    assert.equal((await read.execute({ tab: refs[0], mode: "dom" }, { agent })).snapshot, "dom");
    assert.deepEqual(events.slice(count), [`dom:${refs[0]}`]);
    await root.waterfall("agent/pre-step", { agent, messages: [user] },
      () => Promise.resolve({ kind: "enter", messages: [user] }));
    assert.equal(events.length, count + 1, "replaying a prepared user message must not read or discover again");
    await fiber.dispose();
    console.log("PASS: host context and browser_read discover WebMCP before DOM and allow intentional fallback.");
  } else if (process.argv[3] === "upload-policy") {
    BrowserEngine.prototype.upload = async (_ref, args) => ({ uploaded: args.files, observation: args.observation, expect: args.expect });
    BrowserEngine.prototype.act = async (_ref, args) => ({ steps: args.steps.length, observation: args.observation, expect: args.expect });
    const fiber = root.plugin(plugin); await fiber.await();
    const agent = { session: { id: "upload-session" } }, ref = "dsh-browser://runtime/1";
    const user = { id: "upload-user", source: { kind: "user" }, content: [{ type: "text", text: `Upload C:\\files\\report.txt to @[Tab](${ref})` }] };
    await root.waterfall("agent/pre-step", { agent, messages: [user] }, () => Promise.resolve({ kind: "enter", messages: [user] }));
    assert.equal(user.content.length, 1, "context preparation never edits the original user message");
    const upload = tools.get("browser_upload"), args = { snapshot: "current", selector: "input", files: ["C:\\files\\report.txt"] };
    assert.equal(upload.presentCall(args).kind, "other");
    assert.deepEqual((await upload.execute(args, { agent })).uploaded, args.files);
    await assert.rejects(upload.execute({ ...args, files: ["C:\\secret.txt"] }, { agent }), /exact absolute file path/);
    await assert.rejects(upload.execute({ ...args, files: ["C:\\files\\report.tx"] }, { agent }), /exact absolute file path/);
    await assert.rejects(upload.execute(args, { agent: { session: { id: "other" } } }), /No browser tab is authorized/);
    const tool = { id: "tool-path", source: { kind: "tool" }, content: [{ type: "text", text: "C:\\secret.txt" }] };
    await root.waterfall("agent/pre-step", { agent, messages: [tool] }, () => Promise.resolve({ kind: "enter", messages: [tool] }));
    await assert.rejects(tools.get("browser_act").execute({ snapshot: "current", steps: [{ op: "upload", selector: "input", files: ["C:\\secret.txt"] }] }, { agent }), /exact absolute file path/);
    const act = tools.get("browser_act");
    const scoped = { observation: { selector: "#result", depth: 4 }, expect: { kind: "text", selector: "#result", value: "Saved", timeout: 1000 } };
    const executed = await act.execute({ snapshot: "current", steps: [{ op: "click", selector: "#save" }], ...scoped }, { agent });
    assert.deepEqual(executed.observation, scoped.observation, "post-action scope must reach the engine through the host schema");
    assert.deepEqual(executed.expect, scoped.expect);
    assert.deepEqual((await upload.execute({ ...args, ...scoped }, { agent })).expect, scoped.expect);
    for (const invalid of [{ kind: "visible" }, { kind: "text", selector: "#result" }, { kind: "url" }, { kind: "value", selector: "input", value: "x", timeout: 8001 }]) {
      await assert.rejects(act.execute({ snapshot: "current", steps: [{ op: "click", selector: "#save" }], expect: invalid }, { agent }), /require|8000/);
    }
    await assert.rejects(act.execute({ snapshot: "current", steps: [{ op: "click", selector: "#save" }], observation: { depth: 31 } }, { agent }), /30/);
    await assert.rejects(act.execute({ snapshot: "current", steps: [{ op: "drop", selector: "#drop", files: ["C:\\secret.txt"] }] }, { agent }), /exact absolute file path/);
    assert.equal((await act.execute({ snapshot: "current", steps: [{ op: "drop", selector: "#drop", files: args.files }] }, { agent })).steps, 1);
    await assert.rejects(act.execute({ snapshot: "current", steps: [{ op: "drop", selector: "#drop" }] }, { agent }), /requires files/);
    await assert.rejects(act.execute({ snapshot: "current", steps: [{ op: "drag", selector: "#start" }] }, { agent }), /requires toRef/);
    await assert.rejects(tools.get("browser_network_requests").execute({ action: "start" }, { agent: { session: { id: "other" } } }), /No browser tab is authorized/);
    await fiber.dispose(); console.log("PASS: uploads require a selected tab and exact user-supplied file paths.");
  } else if (process.argv[3] === "grants") {
    // DSH claims one input batch per step, so only the step that carries the user
    // message sees the citation; every later step must keep the grant.
    const agent = { session: { id: "test-session" } };
    const ref = "dsh-browser://profile-1/42";
    const preStep = (messages, step) => root.waterfall("agent/pre-step", { agent, messages, step },
      () => Promise.resolve({ kind: "enter", messages }));
    const first = root.plugin(plugin);
    await first.await();
    const user = { id: "m1", role: "user", source: { kind: "user" },
      content: [{ type: "text", text: `look at @[Example](${ref})` }] };
    await preStep([user], 1);
    const tool = { id: "m2", role: "tool", source: { kind: "tool" }, content: [{ type: "text", text: "{}" }] };
    await preStep([tool], 2);
    await preStep([tool], 3);
    const read = tools.get("browser_read");
    await assert.rejects(async () => read.execute({ tab: ref, limit: 400 }, { agent }), /offline/i);
    await assert.rejects(async () => read.execute({ tab: "dsh-browser://profile-1/99", limit: 400 }, { agent }), /not referenced by the user/i);
    const webmcpList = tools.get("browser_webmcp_list");
    const webmcpCall = tools.get("browser_webmcp_call");
    assert.equal(webmcpList.presentCall({}).kind, "read");
    assert.equal(webmcpCall.presentCall({}).kind, "other", "site hints must not downgrade execution to a read tool");
    await assert.rejects(async () => webmcpList.execute({ tab: "dsh-browser://profile-1/99" }, { agent }), /not referenced by the user/i);
    await assert.rejects(async () => webmcpCall.execute({ tab: "dsh-browser://profile-1/99", catalog: "test", name: "test" }, { agent }), /not referenced by the user/i);
    await first.dispose();
    // A new activation (a DSH restart) reloads the conversation's grants.
    const second = root.plugin(plugin);
    await second.await();
    await assert.rejects(async () => tools.get("browser_read").execute({ tab: ref, limit: 400 }, { agent }), /offline/i);
    await second.dispose();
    console.log("PASS: a cited tab stays authorized for the conversation across steps and restarts.");
  } else {
    if (rejectRegistration) {
      const failed = root.plugin(plugin);
      await assert.rejects(failed.await(), /Test registration failure/);
      await failed.dispose();
      const released = await openPort(port);
      await closePort(released);
    }
    for (let cycle = 0; cycle < 3; cycle++) {
      const fiber = root.plugin(plugin);
      await fiber.await();
      const setup = await fiber.ctx.browserTabs.setup();
      // Each cycle deliberately replaces the listener; do not reuse a pooled
      // socket belonging to the previous plugin activation.
      assert.equal((await fetch(setup.url, { headers: { Connection: "close" } })).status, 200);
      await fiber.dispose();
      const released = await openPort(port);
      await closePort(released);
    }
    console.log("PASS: DSH bridge lifecycle releases the port after unload or failed activation.");
  }
} catch (error) {
  failed = true;
  console.error(error.stack, error.cause || "");
} finally {
  await root.fiber.dispose();
  process.exitCode = failed ? 1 : 0;
}
