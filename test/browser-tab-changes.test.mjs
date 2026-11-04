import { test } from "node:test";
import assert from "node:assert/strict";
import { browserTabChanges } from "../src/browser-tab-changes.js";

test("visible consumers share inventory polling and connection changes include an empty browser", async t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const originalWindow = globalThis.window, focus = new EventTarget();
  globalThis.window = focus;
  t.after(() => { globalThis.window = originalWindow; });
  let state = { connected: false, tabs: [] }, calls = 0, changes = 0;
  const watch = browserTabChanges(() => ({ list: async request => {
    assert.deepEqual(request, {}); calls++; return { ok: true, value: state };
  } }));
  const first = new AbortController(), second = new AbortController();
  const notify = () => changes++;
  watch(notify, first.signal); watch(notify, second.signal);
  await Promise.resolve();
  assert.equal(calls, 1); assert.equal(changes, 2);
  t.mock.timers.tick(1000); await Promise.resolve();
  assert.equal(calls, 2); assert.equal(changes, 2);
  state = { connected: true, tabs: [] };
  focus.dispatchEvent(new Event("focus")); await Promise.resolve();
  assert.equal(changes, 4, "connected with no eligible tabs differs from disconnected");
  first.abort();
  state = { connected: true, tabs: [{ ref: "dsh-browser://test/1", title: "A", url: "https://example.com", browser: "Chrome" }] };
  t.mock.timers.tick(1000); await Promise.resolve();
  assert.equal(changes, 5, "aborting one consumer keeps the other subscribed");
  state.tabs[0].title = "Updated";
  t.mock.timers.tick(1000); await Promise.resolve();
  assert.equal(changes, 6);
  state = { connected: false, tabs: [] };
  t.mock.timers.tick(1000); await Promise.resolve();
  assert.equal(changes, 7);
  state = { connected: true, tabs: [] };
  t.mock.timers.tick(1000); await Promise.resolve();
  assert.equal(changes, 8);
  second.abort(); const stoppedAt = calls;
  t.mock.timers.tick(5000); focus.dispatchEvent(new Event("focus")); await Promise.resolve();
  assert.equal(calls, stoppedAt, "hidden consumers leave no polling or focus listener");
});

test("inventory polling never overlaps requests and ignores a response after disposal", async t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let complete, calls = 0, changes = 0, requestSignal;
  const lifetime = new AbortController();
  const watch = browserTabChanges(() => ({ list: (_request, signal) => {
    calls++; requestSignal = signal; return new Promise(resolve => { complete = resolve; });
  } }), lifetime.signal);
  const controller = new AbortController();
  watch(() => changes++, controller.signal);
  t.mock.timers.tick(5000);
  assert.equal(calls, 1);
  lifetime.abort(); assert.equal(requestSignal.aborted, true);
  complete({ ok: true, value: { connected: true, tabs: [] } }); await Promise.resolve();
  assert.equal(changes, 0);
  t.mock.timers.tick(2000); assert.equal(calls, 1);
  watch(() => changes++, new AbortController().signal);
  assert.equal(calls, 1, "a disposed plugin cannot start another watcher");
});
