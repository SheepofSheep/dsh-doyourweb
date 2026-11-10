import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { BrowserEngine } from "../src/engine.js";
import { BrowserBridge } from "../src/bridge.js";
import { serialize } from "../src/output.js";
import { fileURLToPath } from "node:url";

test("navigate validates the whole batch before dispatch and uses value for valid URLs", async () => {
  let clicks = 0, url = "https://example.com", epoch = 1;
  const page = { evaluate: async () => ({ url, epoch }), title: async () => "Navigate", url: () => url,
    locator: () => ({ ariaSnapshot: async () => "- button [ref=e1]", click: async () => { clicks++; } }),
    goto: async target => { url = target; epoch++; } };
  const engine = new BrowserEngine({ page: async () => page });
  for (const step of [{ op: "navigate" }, { op: "navigate", url: "https://example.org" },
    { op: "navigate", target: "https://example.org" }, { op: "navigate", value: " " },
    { op: "navigate", value: "javascript:alert(1)" }]) {
    const read = await engine.read("tab");
    await assert.rejects(engine.act("tab", { snapshot: read.snapshot, observe: "summary",
      steps: [{ op: "click", ref: "e1" }, step] }), /navigate.*step.value/);
    assert.equal(clicks, 0);
    assert.equal(url, "https://example.com");
    assert.equal((await engine.read("tab")).lastAction.dispatch, "none");
  }
  const read = await engine.read("tab");
  const result = await engine.act("tab", { snapshot: read.snapshot, observe: "summary", steps: [{ op: "navigate", value: "https://example.org" }] });
  assert.equal(result.completed.length, 1);
  assert.equal(url, "https://example.org");
});

test("new same-tab reads replace snapshots; cursor pages and other tabs preserve them", async () => {
  let clicks = 0;
  const page = { evaluate: async () => ({ url: "https://example.com", epoch: 1 }), title: async () => "Pagination",
    locator: () => ({ ariaSnapshot: async () => "- paragraph: text\n".repeat(200), click: async () => { clicks++; } }) };
  const engine = new BrowserEngine({ page: async () => page });
  const old = await engine.read("tab");
  const latest = await engine.read("tab", { limit: 400 });
  await assert.rejects(engine.act("tab", { snapshot: old.snapshot, steps: [{ op: "click", selector: "button" }] }), /latest DOM snapshot for this tab/);
  assert.equal(clicks, 0);
  assert.ok(latest.omittedChars > 0);
  assert.equal((await engine.read("tab", { cursor: latest.cursor })).snapshot, latest.snapshot);
  await engine.read("other");
  const result = await engine.act("tab", { snapshot: latest.snapshot, observe: "summary", steps: [{ op: "click", selector: "button" }] });
  assert.equal(result.completed.length, 1);
  assert.equal(clicks, 1);
});

test("ordinary post-dispatch failure persists the receipt and never replays", async () => {
  const bridge = new EventEmitter();
  let clicks = 0;
  const page = { evaluate: async () => ({ url: "https://example.com", epoch: 1 }), title: async () => "Submit",
    locator: () => ({ ariaSnapshot: async () => "- button [ref=e1]", click: async () => {
      clicks++; bridge.emit("commandSent", "tab", "Input.dispatchMouseEvent");
      throw new Error("navigation wait failed after input");
    } }) };
  bridge.page = async () => page;
  const engine = new BrowserEngine(bridge);
  const read = await engine.read("tab");
  const result = await engine.act("tab", { snapshot: read.snapshot, observe: "summary", steps: [{ op: "click", ref: "e1" }, { op: "click", ref: "e1" }] });
  assert.equal(result.failure.dispatch, "sent");
  assert.equal(result.uncertainStep, 0);
  const recovered = await engine.read("tab");
  assert.equal(recovered.lastAction.actionId, result.actionId);
  assert.equal(recovered.lastAction.failure.dispatch, "sent");
  assert.equal(clicks, 1);
  assert.equal(bridge.listenerCount("commandSent"), 0);
});

test("preflight refuses without dispatch; method invocation alone stays unknown", async () => {
  const page = { evaluate: async () => ({ url: "https://example.com", epoch: 1 }), title: async () => "Submit",
    locator: () => ({ ariaSnapshot: async () => "- button [ref=e1]", click: async () => { throw new Error("locator timeout"); } }) };
  const engine = new BrowserEngine({ page: async () => page });
  let read = await engine.read("tab");
  await assert.rejects(engine.act("tab", { snapshot: read.snapshot, steps: [{ op: "upload", selector: "input", files: ["relative"] }] }), /absolute/);
  read = await engine.read("tab");
  assert.equal(read.lastAction.dispatch, "none");
  const result = await engine.act("tab", { snapshot: read.snapshot, observe: "summary", steps: [{ op: "click", ref: "e1" }] });
  assert.equal(result.failure.dispatch, "unknown");
  read = await engine.read("tab");
  const invalid = await engine.act("tab", { snapshot: read.snapshot, observe: "summary", steps: [{ op: "click", ref: "invalid" }] });
  assert.equal(invalid.failure.dispatch, "none");
  assert.equal(invalid.uncertainStep, undefined);
});

test("upload chooser failure retains the completed trigger stage", async () => {
  let clicks = 0;
  const page = { evaluate: async () => ({ url: "https://example.com", epoch: 1 }), title: async () => "Upload",
    waitForEvent: async () => { throw new Error("chooser timeout"); },
    locator: () => ({ ariaSnapshot: async () => "- button [ref=e1]", evaluate: async () => false, click: async () => { clicks++; } }) };
  const engine = new BrowserEngine({ page: async () => page });
  const read = await engine.read("tab");
  const result = await engine.upload("tab", { snapshot: read.snapshot, selector: "button", files: [fileURLToPath(import.meta.url)], observe: "summary" });
  assert.equal(result.failure.phase, "button_clicked");
  assert.equal(result.failure.dispatch, "unknown");
  assert.equal(result.uncertainStep, 0);
  assert.equal((await engine.read("tab")).lastAction.failure.phase, "button_clicked");
  assert.equal(clicks, 1);
});

test("post-action scope stays explicit, and missing scope cannot fall back to body", async () => {
  const scopes = [];
  let missing = false;
  const page = { evaluate: async () => ({ url: "https://example.com", epoch: 1 }), title: async () => "Scope", url: () => "https://example.com",
    locator: selector => ({ ariaSnapshot: async options => { scopes.push({ selector, depth: options.depth }); if (selector === "#gone" && missing) throw new Error("selector disappeared"); return "- button [ref=e1]"; },
      click: async () => { missing = true; } }) };
  const engine = new BrowserEngine({ page: async () => page });
  let read = await engine.read("tab", { selector: "#panel" });
  const result = await engine.act("tab", { snapshot: read.snapshot, observation: { selector: "#gone", depth: 3 }, steps: [{ op: "click", ref: "e1" }] });
  assert.equal(result.completed.length, 1);
  assert.match(result.readError, /disappeared/);
  assert.equal((await engine.read("tab")).lastAction.readError, true);
  read = await engine.read("tab", { selector: "#panel" });
  await engine.act("tab", { snapshot: read.snapshot, steps: [{ op: "click", ref: "e1" }] });
  assert.deepEqual(scopes.at(-1), { selector: "xpath=/html/body", depth: 8 });
  assert.deepEqual(scopes[1], { selector: "#gone", depth: 3 });
});

test("one final expectation preserves actions across matched, unmet and error outcomes", async () => {
  let evaluations = 0, clicks = 0;
  const page = { evaluate: async () => ({ url: "https://example.com", epoch: 1 }), title: async () => "Expect",
    locator: selector => ({ ariaSnapshot: async () => "- button [ref=e1]", click: async () => { clicks++; },
      evaluate: async (fn, args) => { evaluations++; return fn({ innerText: "Saved successfully", value: "done" }, args); },
      waitFor: async () => { const error = new Error("visibility timed out"); error.name = "TimeoutError"; throw error; } }) };
  const engine = new BrowserEngine({ page: async () => page });
  for (const [expect, status] of [[{ kind: "text", selector: "#result", value: "Saved" }, "matched"],
    [{ kind: "value", selector: "input", value: "wrong" }, "unmet"], [{ kind: "url", value: "https://example.com" }, "matched"],
    [{ kind: "visible", selector: "#result", timeout: 1 }, "unmet"]]) {
    const read = await engine.read("tab");
    const result = await engine.act("tab", { snapshot: read.snapshot, observe: "summary", expect, steps: [{ op: "click", ref: "e1" }] });
    assert.equal(result.expectation.status, status);
    assert.equal(result.completed.length, 1);
    assert.equal((await engine.read("tab")).lastAction.expectation.status, status);
  }
  assert.equal(evaluations, 2);
  assert.equal(clicks, 4);
});

test("request dispatch evidence is emitted only after a WebSocket send succeeds", async () => {
  const bridge = new BrowserBridge();
  const sent = [];
  bridge.on("commandSent", (...args) => sent.push(args));
  const profile = { id: "test", ws: { readyState: 1, send: () => {} } };
  const pending = bridge.request(profile, "chrome.debugger.sendCommand", [{ tabId: 7 }, "Input.dispatchMouseEvent", {}]);
  assert.deepEqual(sent, [["dsh-browser://test/7", "Input.dispatchMouseEvent"]]);
  const entry = [...bridge.pending.values()][0]; clearTimeout(entry.timer); entry.resolve({}); bridge.pending.clear();
  await pending;
  profile.ws.readyState = 3;
  await assert.rejects(bridge.request(profile, "chrome.debugger.sendCommand", [{ tabId: 7 }, "Input.dispatchMouseEvent", {}]), /disconnected/);
  assert.equal(sent.length, 1);
  await bridge.close();
});

test("read-only waits cannot claim dispatch from a concurrent probe", async () => {
  const bridge = new EventEmitter();
  const page = { evaluate: async () => ({ url: "https://example.com", epoch: 1 }), title: async () => "Wait",
    locator: () => ({ ariaSnapshot: async () => "- button [ref=e1]", waitFor: async () => {
      bridge.emit("commandSent", "tab", "Input.dispatchMouseEvent");
      throw new Error("wait failed");
    } }) };
  bridge.page = async () => page;
  const engine = new BrowserEngine(bridge);
  const read = await engine.read("tab");
  const result = await engine.act("tab", { snapshot: read.snapshot, observe: "summary", steps: [{ op: "wait", selector: "#result" }] });
  assert.equal(result.failure.dispatch, "none");
  assert.equal(result.uncertainStep, undefined);
});

test("a minimum-budget recovery keeps twelve completed steps and both post-action failures", async () => {
  let snapshots = 0;
  const page = { evaluate: async () => ({ url: "https://example.com", epoch: 1 }), title: async () => "Receipt", url: () => "https://example.com",
    locator: () => ({ ariaSnapshot: async () => { snapshots++; if (snapshots === 2) throw new Error("missing scope ".repeat(100)); return "- button [ref=e1]"; },
      click: async () => {}, evaluate: async () => { throw new Error("expectation failed ".repeat(100)); } }) };
  const engine = new BrowserEngine({ page: async () => page });
  const read = await engine.read("tab");
  const result = await engine.act("tab", { snapshot: read.snapshot, observation: { selector: "#gone" },
    expect: { kind: "text", selector: "#result", value: "Saved" }, steps: Array.from({ length: 12 }, () => ({ op: "click", ref: "e1" })) });
  assert.equal(result.completed.length, 12);
  assert.equal(result.expectation.status, "error");
  assert.ok(result.readError);
  const recovered = await engine.read("tab", { limit: 400 });
  assert.ok(serialize(recovered).length <= 400);
  assert.equal(recovered.lastAction.completed.length, 12);
  assert.equal(recovered.lastAction.readError, true);
  assert.equal(recovered.lastAction.expectation.status, "error");
});

test("scope and final expectation expose reproducible calls and serialized sizes", async t => {
  const measurements = [];
  for (const scoped of [false, true]) {
    let snapshots = 0, checks = 0;
    const page = { evaluate: async () => ({ url: "https://example.com", epoch: 1 }), title: async () => "Search",
      locator: selector => ({ ariaSnapshot: async () => { snapshots++; return selector === "#results" ? "- status: Found" : "- navigation: large unrelated menu\n".repeat(200); },
        click: async () => {}, evaluate: async () => { checks++; return true; } }) };
    const engine = new BrowserEngine({ page: async () => page });
    const read = await engine.read("tab", { selector: "#results" });
    const result = await engine.act("tab", { snapshot: read.snapshot, ...(scoped ? { observation: { selector: "#results" }, expect: { kind: "text", selector: "#results", value: "Found" } } : {}), steps: [{ op: "click", ref: "e1" }] });
    measurements.push({ scoped, toolCalls: 2, snapshots, checks, responseChars: serialize(result).length, hasCursor: !!result.cursor });
  }
  assert.equal(measurements[0].snapshots, 2); assert.equal(measurements[1].snapshots, 2);
  assert.equal(measurements[1].checks, 1);
  assert.equal(measurements[0].hasCursor, true); assert.equal(measurements[1].hasCursor, false);
  assert.ok(measurements[1].responseChars < measurements[0].responseChars);
  t.diagnostic(JSON.stringify(measurements));
});
