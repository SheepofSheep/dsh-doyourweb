import { test } from "node:test";
import assert from "node:assert/strict";
import { BrowserEngine } from "../src/engine.js";
import { PowerShellWorker } from "../src/apps/powershell.js";

test("handle receipt cannot silently rebind old element refs; cursor admits fresh refs", async () => {
  const calls = [];
  const page = { evaluate: async () => ({ url: "https://example.com", epoch: 1 }), title: async () => "Handles",
    locator: selector => ({ ariaSnapshot: async () => '- button "New" [ref=e2]', click: async () => calls.push(selector) }) };
  const engine = new BrowserEngine({ page: async () => page });
  const initial = await engine.read("tab");
  const handle = await engine.act("tab", { snapshot: initial.snapshot, observe: "handle", steps: [{ op: "click", ref: "e2" }] });
  assert.equal(handle.content, undefined); assert.equal(handle.refs, "read_required");
  await assert.rejects(engine.act("tab", { snapshot: handle.snapshot, steps: [{ op: "click", ref: "e2" }] }), /withheld/);
  await assert.rejects(engine.act("tab", { snapshot: handle.snapshot, steps: [{ op: "drag", selector: "button", toRef: "e2" }] }), /withheld/);
  await assert.rejects(engine.act("tab", { snapshot: initial.snapshot, steps: [{ op: "click", selector: "button" }] }), /stale/);
  assert.deepEqual(calls, ["aria-ref=e2"]);
  const fresh = await engine.read("tab", { cursor: handle.cursor });
  assert.match(fresh.content, /ref=e2/);
  await engine.act("tab", { snapshot: fresh.snapshot, observe: "summary", steps: [{ op: "click", ref: "e2" }] });
  assert.equal(calls.length, 2);
});

test("query/hash routes allow selector observations, but stop before more input", async () => {
  let url = "https://example.com/view", calls = [];
  const page = { evaluate: async () => ({ url, epoch: 1 }), title: async () => "SPA",
    locator: selector => ({ ariaSnapshot: async () => '- button "Route" [ref=e1]', click: async () => { calls.push(selector); url = "https://example.com/view?panel=2#new"; }, evaluateAll: async () => ({ rows: [{ text: "new" }], totalRows: 1 }) }) };
  const engine = new BrowserEngine({ page: async () => page });
  let read = await engine.read("tab");
  const stopped = await engine.act("tab", { snapshot: read.snapshot, observe: "summary", steps: [{ op: "click", ref: "e1" }, { op: "click", ref: "e1" }] });
  assert.equal(stopped.navigated, true); assert.equal(calls.length, 1);
  url = "https://example.com/view"; calls = []; read = await engine.read("tab");
  const continued = await engine.act("tab", { snapshot: read.snapshot, observe: "summary", steps: [{ op: "click", ref: "e1" }, { op: "extract", selector: "#new" }] });
  assert.equal(continued.completed.length, 2); assert.deepEqual(calls, ["aria-ref=e1"]);
  url = "https://example.com/view"; read = await engine.read("tab");
  const input = await engine.act("tab", { snapshot: read.snapshot, observe: "summary", steps: [{ op: "click", ref: "e1" }, { op: "click", selector: "#new" }] });
  assert.equal(input.navigated, true); assert.equal(input.completed.length, 1);
});

test("invalid upload paths stop the entire batch before preceding effects", async () => {
  const actions = [];
  const page = { evaluate: async () => ({ url: "https://example.com", epoch: 1 }), title: async () => "Files",
    locator: () => ({ ariaSnapshot: async () => "- button [ref=e1]", click: async () => actions.push("click") }) };
  const engine = new BrowserEngine({ page: async () => page });
  const read = await engine.read("tab");
  await assert.rejects(engine.act("tab", { snapshot: read.snapshot, steps: [{ op: "click", ref: "e1" }, { op: "upload", selector: "input", files: ["relative.txt"] }] }), /absolute/);
  assert.deepEqual(actions, []);
  await assert.rejects(engine.act("tab", { snapshot: read.snapshot, steps: [{ op: "click", ref: "e1" }, { op: "drop", selector: "#drop", files: ["relative.txt"] }] }), /absolute/);
  assert.deepEqual(actions, []);
});

test("failed drag and drop stop once and expose uncertain effects without replay", async () => {
  for (const op of ["drag", "drop"]) {
    let attempts = 0;
    const page = { evaluate: async () => ({ url: "https://example.com", epoch: 1 }), title: async () => "Drop",
      locator: () => ({ ariaSnapshot: async () => "- button [ref=e1]", dragTo: async () => { attempts++; throw new Error("disconnected after dispatch"); },
        drop: async () => { attempts++; throw new Error("disconnected after dispatch"); } }) };
    const engine = new BrowserEngine({ page: async () => page });
    const read = await engine.read("tab");
    const result = await engine.act("tab", { snapshot: read.snapshot, observe: "summary", steps: [
      { op, selector: "#source", toSelector: "#target", data: { "text/plain": "test" } }, { op: "click", ref: "e1" },
    ] });
    assert.equal(attempts, 1); assert.equal(result.uncertainStep, 0); assert.equal(result.mayHaveLateEffects, true);
    assert.equal(result.completed.length, 0); assert.equal(result.remaining, 2);
  }
});

test("Windows helper reuses loaded types and restarts after cancellation", { skip: process.platform !== "win32" }, async () => {
  const worker = new PowerShellWorker();
  try {
    await worker.run("Add-Type 'public class DshWorkerRegression { public static int Value = 7; }'");
    assert.equal((await worker.run("[DshWorkerRegression]::Value")).stdout, "7");
    const controller = new AbortController();
    const pending = worker.run("Start-Sleep -Seconds 20; 'late'", { signal: controller.signal });
    setTimeout(() => controller.abort(new Error("test stop")), 100);
    await assert.rejects(pending, /test stop/);
    assert.equal((await worker.run("'restarted'")).stdout, "restarted");
  } finally { worker.close(); }
});
