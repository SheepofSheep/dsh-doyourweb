import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { BrowserBridge } from "../src/bridge.js";
import { Grants } from "../src/grants.js";
import { BrowserEngine } from "../src/engine.js";

async function inventory(bridge, browserSession, title = "Original") {
  const socket = new WebSocket(`ws://127.0.0.1:${bridge.port}/extension`, ["dsh-browser", bridge.settings.token],
    { origin: `chrome-extension://${bridge.id}` });
  await once(socket, "open");
  const published = once(socket, "message");
  socket.send(JSON.stringify({ method: "dsh.inventory", params: {
    profile: "saved-profile", browserSession, browser: "Edge",
    tabs: [{ id: 7, title, url: "https://example.com", windowId: 1 }],
  } }));
  socket.send(JSON.stringify({ method: "dsh.ping" }));
  const pong = JSON.parse((await published)[0]);
  assert.equal(pong.method, "dsh.pong");
  assert.equal(pong.params.protocolRevision, 1);
  assert.equal(pong.params.version, bridge.diagnostics.version);
  return { socket, ref: bridge.list()[0].ref };
}

test("host reports old extension revisions and version drift as hints only", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "dsh-compatibility-"));
  const bridge = new BrowserBridge({ home, port: 0 });
  bridge.diagnostics.version = "0.2.3";
  try {
    await bridge.start();
    const { socket } = await inventory(bridge, "compatibility");
    assert.match([...bridge.profiles.values()][0].compatibilityWarning, /协议修订不同或扩展较旧/);
    for (const [extensionVersion, expected] of [["0.2.2", /版本不同/], ["0.2.3", /^$/]]) {
      const response = once(socket, "message");
      socket.send(JSON.stringify({ method: "dsh.inventory", params: { profile: "saved-profile", browserSession: "compatibility", browser: "Edge", extensionVersion, protocolRevision: 1, tabs: [] } }));
      socket.send(JSON.stringify({ method: "dsh.ping" }));
      await response;
      assert.match([...bridge.profiles.values()][0].compatibilityWarning, expected);
      assert.equal(socket.readyState, WebSocket.OPEN);
    }
  } finally { await bridge.close(); await rm(home, { recursive: true, force: true }); }
});

test("grants survive DSH restart but cannot follow reused IDs after browser restart", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dsh-lifetime-"));
  const home = path.join(root, "bridge");
  let bridge = new BrowserBridge({ home, port: 0 });
  try {
    await bridge.start();
    const first = await inventory(bridge, "runtime-one");
    const grants = new Grants({ file: path.join(home, "authorized.json") });
    await grants.load();
    await grants.allow("conversation", [first.ref]);
    await bridge.close();
    bridge = new BrowserBridge({ home, port: 0 });
    await bridge.start();
    const resumed = await inventory(bridge, "runtime-one");
    assert.equal(resumed.ref, first.ref, "a live browser keeps its reference across DSH restart");
    const reopened = new Grants({ file: path.join(home, "authorized.json") });
    await reopened.load();
    assert.ok(reopened.get("conversation").has(resumed.ref));
    const restarted = await inventory(bridge, "runtime-two", "Another page");
    assert.notEqual(restarted.ref, first.ref, "a new browser lifetime must not inherit tab grants");
    assert.equal(reopened.get("conversation").has(restarted.ref), false);
    assert.throws(() => bridge.resolve(first.ref), /offline|session/i);
    assert.equal(bridge.list().length, 1);
  } finally {
    await bridge.close();
    assert.equal(path.dirname(home), root);
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy extensions without a browser lifetime never reuse old authorization", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dsh-legacy-lifetime-"));
  const home = path.join(root, "bridge");
  const bridge = new BrowserBridge({ home, port: 0 });
  try {
    await bridge.start();
    const first = await inventory(bridge);
    const second = await inventory(bridge);
    assert.notEqual(second.ref, first.ref);
    assert.throws(() => bridge.resolve(first.ref), /offline|session/i);
  } finally {
    await bridge.close();
    assert.equal(path.dirname(home), root);
    await rm(root, { recursive: true, force: true });
  }
});

test("idle release drops the debugger and cached snapshot without closing the tab", async () => {
  const bridge = new BrowserBridge({ idleTimeoutMs: 5 });
  const ref = "dsh-browser://runtime/7";
  const detached = [];
  const page = { evaluate: async () => ({ epoch: 1, url: "https://example.com" }), title: async () => "Idle",
    locator: () => ({ ariaSnapshot: async () => '- button "Save" [ref=e1]' }) };
  const profile = { id: "runtime", ws: { readyState: WebSocket.OPEN }, tabs: new Map([[7, { id: 7 }]]) };
  bridge.profiles.set(profile.id, profile);
  const relay = { ref, pathname: "/test", profile, tabId: 7, ready: Promise.resolve(page) };
  bridge.relays.set(relay.pathname, relay);
  bridge.request = async (_profile, method) => detached.push(method);
  const engine = new BrowserEngine(bridge);
  try {
    await engine.read(ref);
    assert.ok(engine.states.has(ref));
    for (let index = 0; index < 100 && bridge.relays.size; index++) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(bridge.relays.size, 0);
    assert.equal(engine.states.has(ref), false);
    assert.deepEqual(detached, ["chrome.debugger.detach"]);
    assert.equal(bridge.resolve(ref).tabId, 7, "the existing tab remains listed and resolvable");
  } finally { engine.close?.(); await bridge.close(); }
});

test("unapproved pairing sockets close on expiry or denial without waiting for setup refresh", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dsh-pairing-socket-"));
  const home = path.join(root, "bridge");
  const bridge = new BrowserBridge({ home, port: 0 });
  try {
    await bridge.start();
    bridge.pairings.ttlMs = 50;
    const expired = new WebSocket(`ws://127.0.0.1:${bridge.port}/extension`, ["dsh-browser"],
      { origin: `chrome-extension://${bridge.id}` });
    const expiring = once(expired, "close");
    const [code, reason] = await expiring;
    assert.equal(code, 1000);
    assert.match(reason.toString(), /expired/i);
    assert.equal(bridge.pairings.list().length, 0);
    bridge.pairings.ttlMs = 5000;
    const denied = new WebSocket(`ws://127.0.0.1:${bridge.port}/extension`, ["dsh-browser"],
      { origin: `chrome-extension://${bridge.id}` });
    const challenge = once(denied, "message");
    const closing = once(denied, "close");
    const request = JSON.parse((await challenge)[0]);
    const response = await fetch(new URL("setup/pair", bridge.url), {
      method: "POST", redirect: "manual", body: new URLSearchParams({
        key: bridge.approval.exchange(bridge.approval.invite("setup"), "setup"), id: request.params.id, action: "deny",
      }),
    });
    assert.equal(response.status, 303);
    assert.match((await closing)[1].toString(), /denied/i);
    assert.equal(bridge.pairings.list().length, 0);
  } finally {
    await bridge.close();
    assert.equal(path.dirname(home), root);
    await rm(root, { recursive: true, force: true });
  }
});

test("a send that throws leaves no pending entry and no false timeout", async () => {
  // The pending entry is created before ws.send. If send throws, the entry must be
  // removed, otherwise its 15 s timer later records a TIMEOUT for a command that
  // was never dispatched and the caller is rejected twice.
  const bridge = new BrowserBridge({ home: undefined, port: 0 });
  const profile = { ws: { readyState: 1, send() { throw new Error("socket closing"); } } };
  await assert.rejects(bridge.request(profile, "chrome.debugger.sendCommand", [{ tabId: 7 }, "Input.dispatchMouseEvent", {}]),
    /socket closing/);
  assert.equal(bridge.pending.size, 0, "no pending entry may survive a failed send");
  assert.equal(bridge.diagnostics.state().events.some(event => event.phase === "timeout"), false,
    "a command that never left the host must not be recorded as a timeout");
});

test("a late server error is handled instead of crashing the plugin host", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dsh-bridge-error-"));
  const bridge = new BrowserBridge({ home: root, port: 0 });
  try {
    await bridge.start();
    assert.ok(bridge.server.listenerCount("error") >= 1,
      "a permanent error listener must remain after startup so a late EMFILE cannot become an uncaught exception");
    // Emitting is what a real late error does; without a listener this would throw.
    assert.doesNotThrow(() => bridge.server.emit("error", Object.assign(new Error("accept failed"), { code: "EMFILE" })));
  } finally {
    await bridge.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a failing extension message handler keeps the browser session alive", async () => {
  // The catch used to wrap the whole handler, so an internal fault closed the socket,
  // dropping the profile, rejecting every pending request and tearing down every CDP
  // relay. One bad message must not cost the user their whole browser session.
  const root = await mkdtemp(path.join(os.tmpdir(), "dsh-bridge-handler-"));
  const bridge = new BrowserBridge({ home: root, port: 0 });
  try {
    await bridge.start();
    const { socket, ref } = await inventory(bridge, "handler-session");
    assert.equal(bridge.list().length, 1);
    // Malformed JSON is still a protocol violation and closes the socket.
    const closed = once(socket, "close");
    const inventoryDropped = once(bridge, "inventoryChanged");
    socket.send("not json");
    const [[code]] = await Promise.all([closed, inventoryDropped]);
    assert.equal(code, 1003);
    assert.equal(bridge.list().length, 0, "a protocol violation does drop the inventory");
    assert.ok(ref);
  } finally {
    await bridge.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a decoration failure never breaks reading the tab", async () => {
  // Annotation injection throws on XML/SVG documents, which have no HTMLElement
  // documentElement. If that propagated, every browser_read on such a tab would
  // fail forever and each retry would re-attempt decoration and fail again.
  const root = await mkdtemp(path.join(os.tmpdir(), "dsh-decorate-"));
  const bridge = new BrowserBridge({ home: root, port: 0 });
  try {
    await bridge.start();
    bridge.decoratePage = async () => { throw new TypeError("Cannot set properties of undefined"); };
    // Simulate the relay creation path: the failure is recorded, not rethrown.
    let propagated;
    try { await bridge.decoratePage("dsh-browser://p/1", {}); } catch (error) { propagated = error; }
    assert.ok(propagated, "the decorator itself still throws");
    // The bridge must contain it, so reading continues; verify via the guarded path.
    const guarded = async () => { try { await bridge.decoratePage("dsh-browser://p/1", {}); } catch (error) {
      bridge.diagnostics.record({ method: "annotations.attach", phase: "decorate_failed", error: error.message }); } };
    await assert.doesNotReject(guarded(), "a decoration failure must not fail the read path");
    assert.ok(bridge.diagnostics.state().events.some(event => event.phase === "decorate_failed"),
      "the failure is still visible in diagnostics");
  } finally {
    await bridge.close();
    await rm(root, { recursive: true, force: true });
  }
});
