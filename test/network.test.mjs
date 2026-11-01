import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { NetworkCapture } from "../src/network.js";
import { BrowserEngine } from "../src/engine.js";
import { Diagnostics } from "../src/diagnostics.js";

test("network capture is opt-in, bounded, paginated and stores metadata only", async () => {
  const page = new EventEmitter(), bridge = new EventEmitter();
  bridge.page = async () => page;
  const engine = new BrowserEngine(bridge);
  assert.equal((await engine.network("tab")).capturing, false);
  assert.equal(page.listenerCount("request"), 0);
  const started = await engine.network("tab", { action: "start" });
  assert.ok(started.capturingSince);
  for (let i = 0; i < 205; i++) {
    const request = { url: () => `https://user:secret@example.com/api/${i}?token=secret#secret`, method: () => "POST", resourceType: () => "fetch" };
    page.emit("request", request);
    page.emit("response", { request: () => request, status: () => i === 204 ? 500 : 200,
      headers: () => ({ "content-type": "application/json; charset=utf-8", "set-cookie": "secret", authorization: "secret" }) });
    page.emit("requestfinished", request);
  }
  const listed = await engine.network("tab", { limit: 2 });
  assert.equal(listed.dropped, 5); assert.equal(listed.requests[0].id, 6); assert.equal(listed.nextAfterId, 7);
  const second = await engine.network("tab", { afterId: listed.nextAfterId, limit: 2 });
  assert.equal(second.requests[0].id, 8);
  const errors = await engine.network("tab", { errorsOnly: true });
  assert.equal(errors.requests.length, 1); assert.equal(errors.requests[0].status, 500);
  const detail = await engine.network("tab", { action: "details", requestId: 205 });
  assert.equal(detail.request.mimeType, "application/json"); assert.ok(detail.request.durationMs >= 0);
  assert.equal(JSON.stringify(detail).includes("secret"), false);
  assert.equal("headers" in detail.request, false);
  assert.equal(engine.networks.get("tab").rows.length, 200);
  await engine.network("tab", { action: "stop" });
  assert.equal(page.listenerCount("request"), 0);
  assert.equal((await engine.network("tab")).capturing, false);
  await engine.network("tab", { action: "start" });
  assert.equal((await engine.network("tab")).requests.length, 0);
  bridge.emit("release", "tab");
  assert.equal(page.listenerCount("request"), 0); assert.equal(engine.networks.size, 0);
  engine.close();
});

test("network filters successful static assets but retains failures; clear removes prior records", () => {
  const page = new EventEmitter(), capture = new NetworkCapture(page);
  for (const state of ["requestfinished", "requestfailed"]) {
    const request = { url: () => "https://example.com/image.png", method: () => "GET", resourceType: () => "image" };
    page.emit("request", request); page.emit(state, request);
  }
  assert.equal(capture.result({}).requests.length, 1);
  assert.equal(capture.result({ includeStatic: true }).requests.length, 2);
  assert.equal(capture.result({ query: "absent" }).requests.length, 0);
  capture.clear(); assert.equal(capture.result({}).requests.length, 0);
  assert.throws(() => capture.result({ action: "details", requestId: 1 }), /unavailable/);
  capture.close();
});

test("diagnostic metadata redacts raw command failures and caps storage", () => {
  const diagnostics = new Diagnostics({ capacity: 2, version: "0.1.7" });
  for (let i = 0; i < 3; i++) diagnostics.record({ id: i, method: "Runtime.callFunctionOn", phase: "host_result",
    error: new Error("timeout https://example.com/?token=secret cookie=secret input=secret"), extensionVersion: "0.1.7" });
  const state = diagnostics.state();
  assert.equal(state.events.length, 2); assert.equal(state.events[0].code, "TIMEOUT");
  assert.equal(JSON.stringify(state).includes("secret"), false);
  diagnostics.state({ enabled: false }); diagnostics.record({ method: "Network.enable" });
  assert.equal(diagnostics.state().events.length, 2);
  assert.equal(diagnostics.state({ clear: true }).events.length, 0);
});
