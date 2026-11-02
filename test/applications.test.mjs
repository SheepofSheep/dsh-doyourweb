import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { AppInventory, appRefs } from "../src/apps/processes.js";
import { Applications } from "../src/apps/service.js";
import { ConnectorCatalog, fingerprint, registryCandidates, validateConnector } from "../src/apps/catalog.js";
import { McpConnection, UncertainOperation, runProcess, projectMcpResult } from "../src/apps/runtime.js";
import { annotationData, Annotations } from "../src/annotations.js";
import { BrowserBridge } from "../src/bridge.js";
import { managementPage } from "../src/manage.js";
import { apply as applyClient } from "../src/client.js";

async function fixture(t, options = {}) {
  const home = await mkdtemp(path.join(os.tmpdir(), "dsh-apps-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const row = { pid: 42, windowId: "123", name: "Fixture", title: "Fixture document", started: "1", path: process.execPath };
  const inventory = new AppInventory({ inventory: async () => [row] });
  inventory.showWindow = async () => true;
  const [app] = await inventory.list();
  const candidate = { id: "fixture-cli", label: "Fixture CLI", kind: "cli", publisher: "fixture.example", provenance: "official", command: process.execPath, args: [], installed: true };
  const catalog = { cache: new Map(), discover: async () => ({ candidates: [{ ...candidate }], searches: [] }) };
  const service = new Applications({ home, managementUrl: "http://127.0.0.1:1/manage", inventory, catalog, ...options });
  t.after(() => service.close());
  await service.load(); await service.discover(app.ref);
  return { home, app, service, candidate, row };
}

test("app menu hides unopened installed apps and decorates running windows", async t => {
  const { service } = await fixture(t);
  service.inventory.list = async () => [{ name: "Closed", installed: true }, { name: "Running", pid: 12, windowId: "34", path: "C:\\Running.exe" }];
  service.icons = { decorate: async apps => apps.map(app => ({ ...app, icon: "fixture-icon" })) };
  const rows = await service.list("");
  assert.deepEqual(rows.map(row => [row.name, row.icon]), [["Running", "fixture-icon"]]);
});

test("installed MCP connects immediately; missing MCP requests installation; CLI is not a fallback candidate", async t => {
  const { service, app, candidate } = await fixture(t, { connect: () => ({ connect: async () => {}, close: async () => {}, catalog: () => [], tools: new Map() }) });
  assert.ok((await service.discover(app.ref)).candidates.every(c => c.kind !== "cli"));
  candidate.kind = "mcp";
  await service.discover(app.ref);
  assert.equal((await service.connect(app.ref, candidate.id, { session: "installed" })).status, "connected");
  candidate.installed = false;
  await service.discover(app.ref);
  assert.equal((await service.connect(app.ref, candidate.id, { session: "missing" })).status, "pending_approval");
});

test("app references expire on PID/window reuse and plugin restart", async () => {
  let row = { pid: 5, windowId: "9", started: "a", name: "Unity", title: "Editor" };
  const inventory = new AppInventory({ inventory: async () => [row] });
  const [app] = await inventory.list();
  assert.deepEqual(appRefs(`@[Editor](${app.ref})`), [app.ref]);
  row = { ...row, started: "b" };
  await assert.rejects(inventory.resolve(app.ref, undefined, { fresh: true }), /exited/);
  const other = new AppInventory({ inventory: async () => [row] });
  assert.notEqual((await other.list())[0].ref, (await inventory.list())[0].ref);
});

test("app window checks share enumeration and a missing window fails without scanning again", async () => {
  let scans = 0, visible = true;
  const row = { pid: 5, windowId: "9", started: "a", name: "Fixture", title: "Editor" };
  const inventory = new AppInventory({ inventory: async () => { scans++; await new Promise(resolve => setTimeout(resolve, 5)); return visible ? [row] : []; } });
  const [app] = await inventory.list();
  await Promise.all(Array.from({ length: 5 }, () => inventory.resolve(app.ref)));
  assert.equal(scans, 1, "cached checks do not launch PowerShell repeatedly");
  await Promise.all(Array.from({ length: 5 }, () => inventory.resolve(app.ref, undefined, { fresh: true })));
  assert.equal(scans, 2, "concurrent strict checks share one enumeration");
  visible = false;
  await assert.rejects(inventory.resolve(app.ref, undefined, { fresh: true }), /exited/);
  for (let count = 0; count < 3; count++) await assert.rejects(inventory.resolve(app.ref), /exited/);
  assert.equal(scans, 3, "missing windows do not trigger a lookup loop");
});

test("registry discovery rejects community substring false positives and preserves named arguments", () => {
  const payload = { servers: [
    { server: { name: "example/community", description: "generic community server", packages: [] } },
    { server: { name: "example/unity", description: "Unity tools", packages: [{ registryType: "npm", identifier: "unity-mcp", version: "1.2.3", transport: { type: "stdio" }, packageArguments: [{ type: "named", name: "--port", value: "1234" }], environmentVariables: [{ name: "TOKEN", isRequired: true }] }] } },
  ] };
  const result = registryCandidates(payload, "unity");
  assert.equal(result.length, 1); assert.equal(result[0].provenance, "community");
  assert.deepEqual(result[0].args, ["--port", "1234"]); assert.deepEqual(result[0].requiredEnvironment, ["TOKEN"]);
  assert.throws(() => validateConnector({ id: "bad", label: "Bad", kind: "mcp", url: "http://evil.example/mcp" }), /HTTPS/);
  assert.throws(() => validateConnector({ id: "bad", label: "Bad", kind: "cli", command: "x", docs: "javascript:alert(1)" }), /source/);
  assert.notEqual(fingerprint({ ...result[0], headers: { Auth: "one" } }), fingerprint({ ...result[0], headers: { Auth: "two" } }));
});

test("official installed CLI ranks before community results; discovery caches metadata", async () => {
  let requests = 0;
  const catalog = new ConnectorCatalog({ find: async () => process.execPath, fetcher: async url => { requests++; return { ok: true, text: async () => JSON.stringify(url.includes("/-/") ? { objects: [] } : { servers: [] }) }; } });
  const app = { name: "Unity", title: "Editor" };
  const result = await catalog.discover(app);
  assert.equal(result.candidates[0].id, "unity-cli"); assert.equal(result.candidates[1].id, "unity-cli-mcp");
  await catalog.discover(app); assert.equal(requests, 2);
});

test("npm CLI discovery still runs when MCP Registry is unavailable", async () => {
  const requests = [];
  const catalog = new ConnectorCatalog({ find: async () => undefined, fetcher: async url => {
    requests.push(url); if (!url.includes("/-/")) throw new Error("Registry unavailable");
    return { ok: true, text: async () => JSON.stringify({ objects: [{ package: { name: "fixture-cli", version: "1.0.0", description: "Fixture command line" } }] }) };
  } });
  const result = await catalog.discover({ name: "Fixture" });
  assert.equal(requests.length, 2); assert.equal(result.candidates[0].id, "npm/fixture-cli"); assert.match(result.discoveryError, /Registry unavailable/);
});

test("MCP and CLI discovery overlap instead of waiting for two network timeouts", async () => {
  let active = 0, peak = 0;
  const catalog = new ConnectorCatalog({ find: async () => undefined, fetcher: async () => {
    peak = Math.max(peak, ++active);
    await new Promise(resolve => setTimeout(resolve, 10)); active--;
    return { ok: true, text: async () => "{}" };
  } });
  await catalog.discover({ name: "Fixture" });
  assert.equal(peak, 2);
});

test("proposed connectors require source review and editing the same id closes old connections", async t => {
  const { service, app } = await fixture(t);
  const config = { id: "proposed-cli", label: "CLI from source research", kind: "cli", docs: "https://example.com/cli", publisher: "example.com", command: process.execPath, args: [] };
  await service.propose(app.ref, config);
  const pending = await service.connect(app.ref, config.id, { session: "s" }); assert.equal(pending.status, "pending_approval");
  const first = await service.approve(pending.plan);
  await service.propose(app.ref, { ...config, args: ["--version"] });
  assert.equal(service.connections.has(first.connection), false);
  assert.equal((await service.connect(app.ref, config.id, { session: "s" })).status, "pending_approval");
  await assert.rejects(service.propose(app.ref, { ...config, id: "bad", env: { TOKEN: "secret" } }), /without secrets/);
});

test("discovered connector templates expose required fields without stored secrets", async t => {
  const { service, app, candidate } = await fixture(t);
  candidate.requiredEnvironment = ["API_TOKEN"]; candidate.env = { API_TOKEN: "private" }; await service.discover(app.ref);
  const template = await service.template(app.ref, candidate.id);
  assert.equal(template.command, process.execPath); assert.deepEqual(template.env, { API_TOKEN: "" });
  assert.equal(JSON.stringify(template).includes("private"), false);
});

test("saving connector configuration invalidates a connection and revocation clears remembered approval", async t => {
  const { service, app, candidate } = await fixture(t);
  const pending = await service.connect(app.ref, candidate.id, { session: "s" }); const connection = await service.approve(pending.plan);
  assert.ok(Object.keys(service.settings.approved).length);
  await service.revoke(connection.connection); assert.equal(service.connections.size, 0); assert.equal(Object.keys(service.settings.approved).length, 0);
  const again = await service.connect(app.ref, candidate.id, { session: "s" }); const reopened = await service.approve(again.plan);
  await service.saveConnector({ ...candidate, args: ["--version"] }); assert.equal(service.connections.has(reopened.connection), false);
});

test("first connection needs human approval even if model supplies an approval flag", async t => {
  let runs = 0;
  const { service, app } = await fixture(t, { run: async () => { runs++; return { exitCode: 0 }; } });
  const pending = await service.connect(app.ref, "fixture-cli", { session: "s", approved: true });
  assert.equal(pending.status, "pending_approval"); assert.equal(runs, 0); assert.equal(service.connections.size, 0);
  const connected = await service.approve(pending.plan);
  assert.equal(connected.status, "connected");
  await assert.rejects(service.approve(pending.plan), /already answered/);
  await assert.rejects(service.call(app.ref, { connection: connected.connection, argv: [] }, { session: "other" }), /another app\/conversation/);
  assert.equal((await service.connect(app.ref, "fixture-cli", { session: "other" })).status, "connected");
});

test("installation is pinned to an approval, and saved executable does not invalidate it", async t => {
  let installs = 0;
  const { service, app, candidate } = await fixture(t, { install: async c => { installs++; return { ...c, installed: true, command: process.execPath }; } });
  candidate.installed = false; candidate.command = "fixture-cli"; candidate.install = { type: "fixture" };
  await service.discover(app.ref);
  const pending = await service.connect(app.ref, candidate.id, { session: "s" });
  assert.equal(installs, 0);
  await service.approve(pending.plan); assert.equal(installs, 1);
  assert.equal((await service.connect(app.ref, candidate.id, { session: "next" })).status, "connected");
  assert.equal(installs, 1);
});

test("turning off install prompts is scoped to reviewed connectors and trusted publishers", async t => {
  const { service, app, candidate } = await fixture(t);
  await service.setPolicy({ askBeforeInstall: false, trustedPublishers: [candidate.publisher] });
  assert.equal((await service.connect(app.ref, candidate.id, { session: "s" })).status, "pending_approval");
  service.settings.approved[fingerprint(candidate)] = { connector: candidate.id };
  candidate.installed = false; candidate.install = { type: "fixture" }; await service.discover(app.ref);
  assert.equal((await service.connect(app.ref, candidate.id, { session: "s" })).status, "pending_approval", "changing installation invalidates prior review");
});

test("approval is single-flight and failed requests are not reusable", async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { service, app, candidate } = await fixture(t, { install: async c => { await gate; return { ...c, installed: true, command: process.execPath }; } });
  candidate.installed = false; await service.discover(app.ref);
  const plan = await service.connect(app.ref, candidate.id, { session: "s" });
  const first = service.approve(plan.plan);
  await assert.rejects(service.approve(plan.plan), /already answered/); release(); await first;
});

test("saving a connector during installation cancels its old connection and approval", async t => {
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
  const { service, app, candidate } = await fixture(t, { install: async c => { entered(); await gate; return { ...c, installed: true, command: process.execPath }; } });
  candidate.installed = false; await service.discover(app.ref);
  const pending = await service.connect(app.ref, candidate.id, { session: "s" });
  const connecting = service.approve(pending.plan); const rejected = assert.rejects(connecting, /changed or was revoked/);
  await started;
  await service.saveConnector({ ...candidate, installed: true, args: ["--version"] });
  release(); await rejected;
  assert.equal(service.plans.get(pending.plan).status, "cancelled");
  assert.equal(service.connections.size, 0); assert.equal(Object.keys(service.settings.approved).length, 0);
  assert.equal(service.settings.installations[candidate.id], undefined);
});

test("saving a proposed connector during handshake retains the new configuration and closes the old transport", async t => {
  let release, entered, closed = 0;
  const gate = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
  const { service, app, candidate } = await fixture(t, { connect: () => ({ connect: async () => { entered(); await gate; }, close: async () => { closed++; } }) });
  candidate.kind = "mcp"; candidate.proposed = true; await service.discover(app.ref);
  const pending = await service.connect(app.ref, candidate.id, { session: "s" });
  const connecting = service.approve(pending.plan); const rejected = assert.rejects(connecting, /changed or was revoked/);
  await started;
  await service.saveConnector({ ...candidate, args: ["--version"] });
  release(); await rejected;
  assert.deepEqual(service.settings.connectors[0].args, ["--version"]);
  assert.equal(service.connections.size, 0); assert.equal(Object.keys(service.settings.approved).length, 0); assert.equal(closed, 1);
});

test("native questions approve only an explicit selected answer; denial executes nothing", async t => {
  const { service, app } = await fixture(t, { ask: async request => ({ answers: [{ id: request.questions[0].id, selected: ["拒绝"] }] }) });
  assert.equal((await service.connect(app.ref, "fixture-cli", { session: "s", agent: {} })).status, "denied");
  assert.equal(service.connections.size, 0);
});

test("uncertain commands cannot be repeated through another mutation before inspection", async t => {
  let first = true;
  const { service, app } = await fixture(t, { run: async () => { if (first) { first = false; throw new UncertainOperation("timeout"); } return { exitCode: 0, stdout: "ok" }; } });
  const pending = await service.connect(app.ref, "fixture-cli", { session: "s" }); const c = await service.approve(pending.plan);
  const exec = { session: "s" }; const call = argv => service.call(app.ref, { connection: c.connection, argv }, exec);
  await assert.rejects(call(["edit"]), /timeout/); await assert.rejects(call(["edit"]), /uncertain effects/);
  await call(["status"]); await call(["edit"]);
});

test("failed CLI and MCP inspection cannot clear an uncertain mutation", async t => {
  const { service, app } = await fixture(t, { run: async () => ({ exitCode: 1, stderr: "inspection failed" }) });
  const pending = await service.connect(app.ref, "fixture-cli", { session: "s" }); const connected = await service.approve(pending.plan);
  service.receipts.set(app.ref, { mayHaveEffects: true });
  await service.call(app.ref, { connection: connected.connection, argv: ["status"] }, { session: "s" });
  assert.equal(service.receipts.get(app.ref).mayHaveEffects, true);
  const connection = service.connections.get(connected.connection);
  connection.candidate.kind = "mcp";
  connection.transport = { tools: new Map([["inspect", { annotations: { readOnlyHint: true } }]]), call: async () => ({ isError: true, content: [{ type: "text", text: "failed" }] }), close: async () => {} };
  await service.call(app.ref, { connection: connected.connection, tool: "inspect" }, { session: "s" });
  assert.equal(service.receipts.get(app.ref).mayHaveEffects, true);
});

test("desktop scope overrides caller pid/window and needs a fresh one-use snapshot", async t => {
  const calls = [];
  const tools = new Map(["get_window_state", "click"].map(name => [name, { name, inputSchema: { type: "object", properties: { pid: { type: "number" }, window_id: { type: "string" } } } }]));
  const { service, app } = await fixture(t, { connect: () => ({ tools, catalog: () => [...tools.values()], connect: async () => {}, close: async () => {}, call: async (name, args) => { calls.push({ name, args }); return { content: [{ type: "text", text: "state" }] }; } }) });
  service.candidates.get(app.ref).set("cua-driver", { id: "cua-driver", label: "Driver", kind: "desktop", command: process.execPath, installed: true, args: [] });
  const pending = await service.connect(app.ref, "cua-driver", { session: "s" }); await service.approve(pending.plan);
  const exec = { session: "s" }; const state = await service.desktop(app.ref, {}, exec);
  service.receipts.set(app.ref, { mayHaveEffects: true });
  await assert.rejects(service.desktop(app.ref, { tool: "click", snapshot: state.snapshot }, exec), /uncertain effects/);
  service.receipts.delete(app.ref);
  await assert.rejects(service.desktop(app.ref, { tool: "click" }, exec), /fresh desktop snapshot/);
  await service.desktop(app.ref, { tool: "click", snapshot: state.snapshot, arguments: { pid: 999, window_id: "999", delivery_mode: "foreground" } }, exec);
  assert.equal(calls.at(-1).args.pid, 42); assert.equal(calls.at(-1).args.window_id, "123"); assert.equal(calls.at(-1).args.delivery_mode, "background");
  await assert.rejects(service.desktop(app.ref, { tool: "click", snapshot: state.snapshot }, exec), /fresh desktop snapshot/);
  tools.get("get_window_state").inputSchema.properties.window_id = { anyOf: [{ type: "integer" }, { type: "null" }] };
  await service.desktop(app.ref, {}, exec); assert.equal(calls.at(-1).args.window_id, 123);
  assert.equal((await service.connect(app.ref, "cua-driver", { session: "other" })).status, "pending_approval");
});

async function desktopFixture(t, respond = async () => ({ content: [{ type: "text", text: "window controls" }] })) {
  const calls = [];
  const properties = { pid: { type: "integer" }, window_id: { type: "integer" }, include_screenshot: { type: "boolean" }, include_accessibility_tree: { type: "boolean" }, max_elements: { type: "integer" }, max_depth: { type: "integer" }, max_dimension: { type: "integer" } };
  const tools = new Map(["get_window_state", "click", "double_click", "right_click", "scroll", "drag"].map(name => [name, { name, inputSchema: { type: "object", properties } }]));
  const f = await fixture(t, { connect: () => ({ tools, catalog: () => [...tools.values()], connect: async () => {}, close: async () => {}, call: async (name, args, options) => { calls.push({ name, args, options }); return respond(name, args); } }) });
  f.service.candidates.get(f.app.ref).set("cua-driver", { id: "cua-driver", label: "Driver", kind: "desktop", command: process.execPath, installed: true, args: [] });
  const pending = await f.service.connect(f.app.ref, "cua-driver", { session: "s" }); await f.service.approve(pending.plan);
  return { ...f, calls, tools, exec: { session: "s" } };
}

test("desktop defaults to bounded text-only reads and stops identical read-only polling", async t => {
  const { service, app, exec, calls } = await desktopFixture(t);
  const first = await service.desktop(app.ref, {}, exec);
  assert.equal(calls[0].args.include_screenshot, false);
  assert.equal(calls[0].args.include_accessibility_tree, true);
  assert.ok(calls[0].args.max_elements <= 200); assert.ok(calls[0].args.max_depth <= 10);
  const cached = await service.desktop(app.ref, {}, exec);
  assert.equal(cached.snapshot, first.snapshot); assert.equal(cached.cached, true); assert.equal(calls.length, 1);
  const stopped = await service.desktop(app.ref, {}, exec);
  assert.equal(stopped.status, "no_progress"); assert.equal(stopped.stop, true); assert.equal(calls.length, 1);
  const fresh = await service.desktop(app.ref, { refresh: true }, exec);
  assert.notEqual(fresh.snapshot, first.snapshot); assert.equal(calls.length, 2);
});

test("desktop shows a window once per connection and keeps subsequent reads in the background", async t => {
  const { service, app, exec, calls, row } = await desktopFixture(t);
  let shown = 0, scans = 0;
  service.inventory.showWindow = async () => { shown++; return true; };
  service.inventory.inventory = async () => { scans++; return [row]; };
  const first = await service.desktop(app.ref, {}, exec);
  assert.equal(shown, 1); assert.equal(scans, 2);
  scans = 0;
  const cached = await service.desktop(app.ref, {}, exec);
  assert.equal(cached.cached, true); assert.equal(shown, 1); assert.equal(scans, 1);
  assert.equal((await service.desktop(app.ref, {}, exec)).status, "no_progress");
  await service.desktop(app.ref, { tool: "controls", snapshot: first.snapshot }, exec);
  await service.desktop(app.ref, { tool: "capabilities" }, exec);
  const refreshed = await service.desktop(app.ref, { refresh: true }, exec);
  await service.desktop(app.ref, { tool: "click", snapshot: refreshed.snapshot }, exec);
  await service.desktop(app.ref, {}, exec);
  assert.equal(shown, 1, "consuming a snapshot does not reset window presentation");
  const reads = calls.filter(call => call.name === "get_window_state").length;
  const explicit = await service.desktop(app.ref, { foreground: true }, exec);
  assert.equal(shown, 2); assert.notEqual(explicit.snapshot, refreshed.snapshot);
  assert.equal(calls.filter(call => call.name === "get_window_state").length, reads + 1);
});

test("desktop honors background reads and presents restored or replacement windows with a fresh snapshot", async t => {
  const { service, app, exec, calls, row } = await desktopFixture(t);
  let shown = 0;
  service.inventory.showWindow = async () => { shown++; row.minimized = false; row.inputX = 10; return true; };
  await service.desktop(app.ref, { foreground: false }, exec);
  assert.equal(shown, 0);
  const visible = await service.desktop(app.ref, {}, exec);
  assert.equal(shown, 1);
  row.minimized = true; row.inputX = -32000;
  const restored = await service.desktop(app.ref, {}, exec);
  assert.equal(shown, 2); assert.equal(restored.geometry.minimized, false);
  assert.notEqual(restored.snapshot, visible.snapshot); assert.equal(calls.length, 3);
  const focused = await service.desktop(app.ref, { tool: "focus_window", foreground: false }, exec);
  assert.equal(shown, 3); assert.notEqual(focused.snapshot, restored.snapshot);
  row.pid = 43; row.windowId = "456"; row.started = "2";
  const replacement = await service.desktop(app.ref, {}, exec);
  assert.equal(shown, 4); assert.notEqual(replacement.snapshot, focused.snapshot);
  assert.equal(calls.at(-1).args.window_id, 456);
});

test("failed best-effort presentation still bounds unchanged polling", async t => {
  const { service, app, exec, calls } = await desktopFixture(t);
  service.inventory.showWindow = async () => false;
  await service.desktop(app.ref, {}, exec);
  assert.equal((await service.desktop(app.ref, {}, exec)).cached, true);
  assert.equal((await service.desktop(app.ref, {}, exec)).status, "no_progress");
  assert.equal(calls.length, 1);
});

test("desktop control pages and exact-name actions reuse the same driver snapshot", async t => {
  const data = { snapshot_id: "s0000000d", elements: [{ element_index: 13, element_token: "s0000000d:13", role: "ComboBox", label: "搜索商店" }] };
  const { service, app, exec, calls, tools } = await desktopFixture(t, async () => ({ structuredContent: data, content: [] }));
  tools.get("click").inputSchema.properties.snapshot_id = { type: "string" };
  const state = await service.desktop(app.ref, {}, exec);
  assert.equal(state.snapshot_id, data.snapshot_id);
  const page = await service.desktop(app.ref, { tool: "controls", snapshot: state.snapshot, arguments: { offset: 0 } }, exec);
  assert.equal(page.controls[0].element_token, "s0000000d:13"); assert.equal(calls.length, 1);
  await service.desktop(app.ref, { snapshot: state.snapshot, tool: "click", arguments: { element: { name: "搜索商店" } } }, exec);
  assert.equal(calls[1].args.element_token, "s0000000d:13");
  await assert.rejects(service.desktop(app.ref, { tool: "not_a_tool" }, exec), /Allowed operations and parameters/);
});

test("background refusal preserves an unconsumed snapshot without an uncertainty lock", async t => {
  const { service, app, exec, calls } = await desktopFixture(t, async name => name === "click"
    ? { isError: true, structuredContent: { effect: "refused", route: "synthetic_events" }, content: [] } : { content: [] });
  const state = await service.desktop(app.ref, {}, exec);
  const result = await service.desktop(app.ref, { tool: "click", snapshot: state.snapshot }, exec);
  assert.equal(result.status, "action_refused"); assert.equal(result.input_dispatched, false);
  assert.equal(result.failed_step, 1); assert.equal(result.retryable, false);
  assert.equal(result.snapshot, state.snapshot); assert.equal(service.receipts.has(app.ref), false);
  await service.desktop(app.ref, { tool: "controls", snapshot: result.snapshot }, exec);
  assert.equal(calls.length, 2, "paging a refusal does not trigger another UIA read");
});

test("minimized windows cannot dispatch input; focus_window restores and reads a new snapshot", async t => {
  const { service, app, exec, calls, row } = await desktopFixture(t);
  const state = await service.desktop(app.ref, {}, exec);
  row.minimized = true; row.inputX = -32000;
  await assert.rejects(service.desktop(app.ref, { tool: "click", snapshot: state.snapshot }, exec), /sentinel/);
  assert.equal(calls.length, 1);
  service.inventory.showWindow = async () => { row.minimized = false; row.inputX = 100; };
  const restored = await service.desktop(app.ref, { tool: "focus_window", foreground: false }, exec);
  assert.notEqual(restored.snapshot, state.snapshot); assert.equal(restored.geometry.minimized, false);
});

test("type plus Enter and expectation uses one read afterward and returns fresh controls", async t => {
  let typed = false;
  const { service, app, exec, calls, tools } = await desktopFixture(t, async name => {
    if (name === "type_text") typed = true;
    return { structuredContent: name === "get_window_state" ? { snapshot_id: typed ? "s00000002" : "s00000001",
      elements: [{ element_index: 13, element_token: typed ? "s00000002:13" : "s00000001:13", role: "ComboBox", label: "搜索商店", value: typed ? "Isaac" : "" }] } : { effect: "confirmed", route: "accessibility" }, content: [] };
  });
  for (const name of ["type_text", "press_key"]) tools.set(name, { name, inputSchema: { properties: { pid: { type: "integer" }, window_id: { type: "integer" }, snapshot_id: { type: "string" } } } });
  const read = await service.desktop(app.ref, {}, exec);
  const result = await service.type(app.ref, { snapshot: read.snapshot, element_index: 13, text: "Isaac", keys: ["Enter"], expect: { name: "搜索商店", value: "Isaac" } }, exec);
  assert.equal(result.status, "verified"); assert.equal(result.observation.snapshot_id, "s00000002");
  assert.deepEqual(calls.map(c => c.name), ["get_window_state", "type_text", "press_key", "get_window_state"]);
  assert.equal(calls[1].args.snapshot_id, "s00000001"); assert.equal(calls[2].args.key, "Enter");
  assert.notEqual(result.snapshot, read.snapshot);
});

test("desktop attempts one bounded automatic launch and never repeats inputs or launch on failure", async t => {
  const { service, app, exec, calls } = await desktopFixture(t);
  let scans = 0, launches = 0;
  service.inventory.launch = async () => { launches++; };
  service.inventory.wait = async () => {};
  service.inventory.inventory = async () => { scans++; return []; };
  const result = await service.desktop(app.ref, {}, exec);
  assert.equal(result.status, "window_unavailable"); assert.equal(result.stop, true); assert.equal(result.retryable, false);
  assert.equal(calls.length, 0);
  await service.desktop(app.ref, {}, exec);
  assert.equal(scans, 10); assert.equal(launches, 1);
});

test("background CLI stays usable after the selected window closes", async t => {
  const { service, app } = await fixture(t, { run: async () => ({ stdout: "background success", exitCode: 0 }) });
  service.inventory.inventory = async () => [];
  await service.inventory.list("", undefined, true);
  const pending = await service.connect(app.ref, "fixture-cli", { session: "s" });
  const connected = await service.approve(pending.plan);
  const result = await service.call(app.ref, { connection: connected.connection, argv: ["status"] }, { session: "s" });
  assert.equal(result.result.stdout, "background success");
});

test("desktop launches a closed selected app, reads its new window, and rejects old snapshots", async t => {
  const { service, app, row, exec, calls } = await desktopFixture(t);
  const previous = await service.desktop(app.ref, {}, exec);
  let rows = [], launches = 0;
  service.inventory.inventory = async () => rows;
  service.inventory.wait = async () => {};
  service.inventory.launch = async selected => { assert.equal(selected.path, row.path); launches++; rows = [{ ...row, pid: 43, windowId: "456", started: "2" }]; };
  const result = await service.desktop(app.ref, {}, exec);
  assert.equal(launches, 1); assert.notEqual(result.snapshot, previous.snapshot);
  assert.equal(calls.at(-1).args.pid, 43); assert.equal(calls.at(-1).args.window_id, 456);
  await assert.rejects(service.desktop(app.ref, { tool: "click", snapshot: previous.snapshot }, exec), /fresh desktop snapshot/);
  await service.desktop(app.ref, { tool: "click", snapshot: result.snapshot }, exec);
  assert.equal(calls.at(-1).args.delivery_mode, "background");
});

test("an installed app is selectable before launch and ambiguous replacement windows are not guessed", async () => {
  const row = { name: "Fixture", title: "Fixture", path: "C:\\Apps\\Fixture.exe", installed: true };
  let rows = [row], launches = 0;
  const inventory = new AppInventory({ inventory: async () => rows, wait: async () => {}, launch: async () => {
    launches++; rows = [{ ...row, pid: 1, started: "1", windowId: "2" }];
  } });
  const [app] = await inventory.list();
  assert.equal((await inventory.resolve(app.ref, undefined, { window: false })).installed, true);
  const opened = await inventory.ensureWindow(app.ref); assert.equal(opened.pid, 1); assert.equal(launches, 1);
  rows = [{ ...row, pid: 2, started: "2", windowId: "3" }, { ...row, pid: 2, started: "2", windowId: "4" }];
  await assert.rejects(inventory.ensureWindow(app.ref), /Several windows/);
  assert.equal(launches, 1);
});

test("mouse clicks and drags share one visual snapshot and stop without automatic captures", async t => {
  const { service, app, exec, calls } = await desktopFixture(t, async (_name, args) => args.include_screenshot
    ? { content: [{ type: "image", mimeType: "image/png", data: "aGVsbG8=" }] } : { content: [{ type: "text", text: "ok" }] });
  const text = await service.desktop(app.ref, {}, exec);
  await assert.rejects(service.mouse(app.ref, { snapshot: text.snapshot, steps: [{ action: "click", x: 20, y: 30 }] }, exec), /visual snapshot/);
  const visual = await service.desktop(app.ref, { screenshot: true, arguments: { include_accessibility_tree: false, screenshot_out_file: "unreviewed.png", scope: "desktop" } }, exec);
  assert.equal(calls.at(-1).args.include_screenshot, true); assert.equal(calls.at(-1).args.include_accessibility_tree, false);
  assert.equal(calls.at(-1).args.screenshot_out_file, undefined);
  const before = calls.length;
  const result = await service.mouse(app.ref, { snapshot: visual.snapshot, steps: [
    { action: "click", x: 20, y: 30 }, { action: "double_click", x: 25, y: 35 }, { action: "right_click", x: 30, y: 40 },
    { action: "drag", x: 10, y: 15, toX: 60, toY: 80, durationMs: 600 }, { action: "scroll", direction: "down", amount: 3 },
  ] }, exec);
  assert.equal(result.completed, 5); assert.equal(result.status, "completed"); assert.equal(calls.length, before + 5);
  assert.deepEqual(calls.slice(before).map(call => call.name), ["click", "double_click", "right_click", "drag", "scroll"]);
  assert.equal(calls.at(-2).args.from_x, 10); assert.equal(calls.at(-2).args.to_y, 80); assert.equal(calls.at(-2).args.duration_ms, 600);
  assert.ok(calls.slice(before).every(call => call.args.pid === 42 && call.args.window_id === 123 && call.args.delivery_mode === "background"));
  assert.ok(calls.slice(before).every(call => call.options.timeout <= 15000));
  await assert.rejects(service.mouse(app.ref, { snapshot: visual.snapshot, steps: [{ action: "click", x: 1, y: 2 }] }, exec), /fresh desktop snapshot/);
});

test("a desktop batch validates all steps first and never replays a partially failed batch", async t => {
  let fail = false;
  const { service, app, exec, calls } = await desktopFixture(t, async name => ({ isError: fail && name === "drag", content: [{ type: "text", text: "result" }] }));
  const connection = [...service.connections.values()][0];
  connection.transport.validate = name => { if (name === "drag") throw new Error("Invalid MCP arguments"); };
  const state = await service.desktop(app.ref, {}, exec);
  const batch = { snapshot: state.snapshot, steps: [{ tool: "click", arguments: { element_index: 1 } }, { tool: "drag" }, { tool: "click", arguments: { element_index: 2 } }] };
  const before = calls.length;
  await assert.rejects(service.desktop(app.ref, batch, exec), /Invalid MCP arguments/);
  assert.equal(calls.length, before);
  connection.transport.validate = () => {}; fail = true;
  const stopped = await service.desktop(app.ref, batch, exec);
  assert.equal(stopped.status, "action_failed"); assert.equal(stopped.stop, true); assert.equal(stopped.completed, 1);
  assert.equal(stopped.failed_step, 2); assert.equal(stopped.retryable, false);
  assert.deepEqual(stopped.result, stopped.steps[1].result, "existing failure result remains available");
  assert.deepEqual(calls.slice(before).map(call => call.name), ["click", "drag"]);
  await assert.rejects(service.desktop(app.ref, batch, exec), /uncertain effects/);
});

test("failed window inspection stops and cannot clear uncertain effects or authorize input", async t => {
  const { service, app, exec } = await desktopFixture(t, async () => ({ isError: true, content: [{ type: "text", text: "Window is closed" }] }));
  service.receipts.set(app.ref, { mayHaveEffects: true });
  const failed = await service.desktop(app.ref, {}, exec);
  assert.equal(failed.status, "read_failed"); assert.equal(failed.stop, true); assert.equal(failed.snapshot, undefined);
  assert.equal(service.receipts.get(app.ref).mayHaveEffects, true);
});

test("mouse batches traverse real stdio MCP with scoped driver schemas and image grounding", async t => {
  const { service, app } = await fixture(t);
  service.candidates.get(app.ref).set("cua-driver", { id: "cua-driver", label: "Protocol fixture", kind: "desktop", installed: true,
    command: process.execPath, args: [fileURLToPath(new URL("./fixtures/desktop-mcp.mjs", import.meta.url))] });
  const exec = { session: "s" };
  const pending = await service.connect(app.ref, "cua-driver", exec); const connected = await service.approve(pending.plan);
  assert.deepEqual(connected.actions, ["get_window_state", "click", "drag"]);
  assert.equal(connected.tools, undefined, "desktop connection does not dump unrelated full schemas");
  const state = await service.desktop(app.ref, { screenshot: true, arguments: { include_accessibility_tree: false } }, exec);
  assert.ok(state.result.content.some(block => block.type === "image"));
  const response = await service.mouse(app.ref, { snapshot: state.snapshot,
    steps: [{ action: "click", x: 1, y: 2 }, { action: "drag", x: 1, y: 2, toX: 3, toY: 4 }] }, exec);
  assert.equal(response.completed, 2);
  const drag = JSON.parse(response.steps[1].result.content[0].text);
  assert.equal(drag.pid, app.pid); assert.equal(drag.window_id, Number(app.windowId));
  assert.equal(drag.scope, "window"); assert.equal(drag.delivery_mode, "background"); assert.equal(drag.to_x, 3);
});

test("foreground batches require one confirmation and reject snapshots that expire while waiting", async t => {
  const { service, app, exec, calls } = await desktopFixture(t);
  const read = await service.desktop(app.ref, {}, exec);
  let questions = 0;
  service.ask = async request => {
    questions++;
    service.snapshots.get(`s:${app.ref}`).time = Date.now() - 90001;
    return { answers: [{ id: request.questions[0].id, selected: ["允许"] }] };
  };
  await assert.rejects(service.desktop(app.ref, { foreground: true, snapshot: read.snapshot,
    steps: [{ tool: "click", arguments: { element_index: 1 } }, { tool: "click", arguments: { element_index: 2 } }] }, { ...exec, agent: {} }), /expired/);
  assert.equal(questions, 1); assert.equal(calls.length, 1, "expired confirmation cannot send either input");
});

test("MCP stdio performs real handshake, schema validation, calls and cancellation", async t => {
  const connection = new McpConnection({ command: process.execPath, args: [fileURLToPath(new URL("./fixtures/app-mcp.mjs", import.meta.url))] });
  t.after(() => connection.close()); await connection.connect();
  assert.equal(connection.catalog("inspect")[0].name, "inspect");
  await assert.rejects(connection.call("inspect", { value: "wrong" }), /Invalid MCP arguments/);
  assert.equal((await connection.call("inspect", { value: 3 })).content[0].text, '{"value":3}');
  await assert.rejects(connection.call("delay", {}, { timeout: 40 }), UncertainOperation);
});

test("CLI runs literal argv without shell interpolation and cancels promptly", async () => {
  const result = await runProcess(process.execPath, ["-e", "process.stdout.write(process.argv[1])", "hello & echo PWNED"]);
  assert.equal(result.stdout, "hello & echo PWNED");
  await assert.rejects(runProcess(process.execPath, ["-e", "setInterval(()=>{},1000)"], { timeout: 30 }), UncertainOperation);
});

test("CLI app calls share the requested output budget while retaining stderr diagnostics", async t => {
  const { service, app } = await fixture(t);
  const pending = await service.connect(app.ref, "fixture-cli", { session: "s" });
  const connected = await service.approve(pending.plan);
  const { result } = await service.call(app.ref, { connection: connected.connection, limit: 400,
    argv: ["-e", "process.stdout.write('x'.repeat(14000));process.stderr.write('y'.repeat(14000));process.exitCode=1"] }, { session: "s" });
  assert.equal(result.stdout.length + result.stderr.length, 400);
  assert.ok(result.stdout.length > 0 && result.stderr.length > 0);
  assert.equal(result.exitCode, 1); assert.equal(result.truncated, true);
});

test("desktop batches share their text budget even with many result blocks per step", async t => {
  const { service, app, exec } = await desktopFixture(t, async () => ({ content: Array.from({ length: 20 }, () => ({ type: "text", text: "x".repeat(1000) })) }));
  const state = await service.desktop(app.ref, {}, exec);
  const result = await service.desktop(app.ref, { snapshot: state.snapshot, limit: 400,
    steps: Array.from({ length: 8 }, () => ({ tool: "click", arguments: { element_index: 1 } })) }, exec);
  assert.equal(result.completed, 8);
  assert.equal(result.steps.reduce((sum, step) => sum + step.result.content.reduce((size, block) => size + (block.text?.length || 0), 0), 0), 400);
  assert.ok(result.steps.every(step => step.result.content.length === 1), "exhausted budgets do not emit empty text blocks");
});

test("MCP compatibility JSON is sent once while distinct commentary remains available", async () => {
  const data = { count: 2, items: ["first", "second"] };
  const output = await projectMcpResult({ structuredContent: data, content: [
    { type: "text", text: JSON.stringify({ items: data.items, count: data.count }, null, 2) },
    { type: "text", text: "Inspected two items." },
  ] }, os.tmpdir(), 400);
  assert.deepEqual(JSON.parse(output.structured), data);
  assert.deepEqual(output.content, [{ type: "text", text: "Inspected two items." }]);
  assert.ok(output.structured.length + output.content[0].text.length <= 400);
});

test("MCP image results are local files, not base64 in model text", async t => {
  const { home } = await fixture(t);
  const output = await projectMcpResult({ content: [{ type: "text", text: "x".repeat(10000) }, { type: "image", mimeType: "image/png", data: "aGVsbG8=" }] }, home, 500);
  assert.equal(output.content[0].text.length <= 500, true); assert.equal(await readFile(output.content[1].path, "utf8"), "hello");
  assert.equal(JSON.stringify(output).includes("aGVsbG8="), false);
});

test("annotations go straight to a conversation with no plugin files or annotation collection", async t => {
  const { home } = await fixture(t);
  const value = { comment: "Make button green", selector: "#save", url: "https://example.com", text: "Save", rect: { x: 1, y: 2, width: 20, height: 10 } };
  assert.throws(() => annotationData({ ...value, rect: { x: Infinity } }), /bounds/);
  assert.equal(annotationData({ ...value, text: "x".repeat(999) }).text.length, 600);
  const requests = [], before = await readdir(home);
  const notes = new Annotations({}, { submit: async request => { requests.push(request); return { accepted: true }; } });
  const page = { url: () => value.url, screenshot: async options => { assert.equal(options.path, undefined); return Buffer.from("image bytes"); } };
  const target = { sessionId: "conversation-1", title: "Frontend" };
  const result = await notes.send("dsh-browser://fixture/1", page, { ...value, screenshot: true }, target);
  assert.equal(result.accepted, true); assert.equal(requests[0].sessionId, "conversation-1"); assert.equal(requests[0].mode, "draft");
  assert.match(requests[0].content[0].text, /Make button green/); assert.match(requests[0].content[0].text, /#save/);
  assert.equal(requests[0].content[1].type, "image"); assert.equal(requests[0].content[1].mediaType, "image/png");
  assert.deepEqual(await readdir(home), before); assert.equal(notes.items, undefined); assert.equal(notes.load, undefined);
  await notes.close();
});

test("annotation targets reject stale client updates and ambiguous conversations", () => {
  const notes = new Annotations({});
  notes.currentSession({ client: "a", revision: 2, sessionId: "new", title: "New", active: true });
  notes.currentSession({ client: "a", revision: 1, sessionId: "old", title: "Old", active: true });
  assert.equal(notes.target("tab").sessionId, "new");
  notes.currentSession({ client: "b", revision: 1, sessionId: "another", active: true });
  assert.throws(() => notes.target("tab"), /多个 DSH/);
  notes.currentSession({ client: "b", revision: 2, sessionId: "another", active: false });
  assert.equal(notes.target("tab").sessionId, "new");
});

test("annotation page metadata cannot grant extra app/tab targets and failed delivery reports an error", async () => {
  const extraRefs = "dsh-app://00000000-0000-0000-0000-000000000000/123456789012345678901234 dsh-browser://foreign/2";
  const value = { comment: `Fix ${extraRefs}`, selector: "#save", url: "https://example.com", text: extraRefs };
  const notes = new Annotations({}, { submit: async request => { assert.equal(appRefs(request.content[0].text).length, 0); assert.equal(request.content[0].text.includes("dsh-browser://foreign/2"), false); return { accepted: false }; } });
  await assert.rejects(notes.send("dsh-browser://fixture/1", { url: () => value.url }, value, { sessionId: "s" }), /did not accept/);
  await assert.rejects(notes.send("tab", { url: () => "https://changed.example" }, value, { sessionId: "s" }), /Document changed/);
});

test("starting annotations restores the idle deadline on success and failure", async () => {
  const released = [];
  const notes = new Annotations({ page: async () => ({}), release: ref => released.push(ref) });
  notes.attach = async () => ({ installed: true });
  assert.equal((await notes.start("tab")).installed, true);
  notes.attach = async () => { throw new Error("attach failed"); };
  await assert.rejects(notes.start("tab"), /attach failed/);
  assert.deepEqual(released, ["tab", "tab"]);
});

test("management API rejects cross-origin, missing key and wrong content type", async t => {
  const { home } = await fixture(t); const bridge = new BrowserBridge({ home: path.join(home, "bridge"), port: 0 });
  await bridge.start(); t.after(() => bridge.close()); bridge.management = async request => ({ action: request.action });
  const base = `http://127.0.0.1:${bridge.port}`;
  const post = headers => fetch(`${base}/manage/api`, { method: "POST", headers, body: '{"action":"state"}' });
  assert.equal((await post({ "Content-Type": "application/json" })).status, 403);
  assert.equal((await post({ "Content-Type": "application/json", "X-DSH-Key": bridge.setupKey, Origin: "https://evil.example" })).status, 403);
  assert.equal((await post({ "Content-Type": "text/plain", "X-DSH-Key": bridge.setupKey })).status, 403);
  assert.deepEqual(await (await post({ "Content-Type": "application/json", "X-DSH-Key": bridge.setupKey, Origin: base })).json(), { action: "state" });
  const page = await fetch(`${base}/manage`); assert.match(page.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  const { html } = managementPage("fixture"); new vm.Script(html.match(/<script nonce="[^"]+">([\s\S]*)<\/script>/)[1]);
});

test("@ exposes applications but no longer exposes a stored annotation library", async () => {
  const sources = []; const app = { ref: "dsh-app://00000000-0000-0000-0000-000000000000/123456789012345678901234", name: "Unity", title: "Editor", pid: 42 };
  const service = { apps: async () => ({ ok: true, value: { apps: [app] } }), annotations: async () => ({ ok: true, value: { annotations: [{ ref: "dsh-annotation://00000000-0000-0000-0000-000000000000", comment: "Fix button", selector: "#save" }] } }) };
  applyClient({ effect: fn => fn(), remote: { $mount: () => {} }, get: () => service, inputTriggers: { registerSource: source => sources.push(source) } }, { browserIcon: () => null, tabIcon: () => () => null });
  for (const name of ["desktop-apps"]) {
    const source = sources.find(s => s.name === name); const [item] = await source.candidates({}, {});
    assert.equal(source.onPick({ candidate: item }).insert.source, name);
    assert.deepEqual(await source.candidates({}, { quoted: true }), []);
  }
  assert.ok(sources.find(s => s.name === "browser-tabs"));
  assert.equal(sources.some(s => s.name === "page-annotations"), false);
});
