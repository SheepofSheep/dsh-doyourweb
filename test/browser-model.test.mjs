import test from "node:test";
import assert from "node:assert/strict";
import { BrowserModel } from "../src/vendor/browser-model.js";

const target = tabId => ({ targetId: `t${tabId}`, type: "page", title: `Tab ${tabId}`, url: "https://example.com", attached: false });

function model() {
  const calls = [];
  const sent = [];
  const m = new BrowserModel(async (method, params) => {
    calls.push({ method, params });
    if (method === "chrome.debugger.sendCommand" && params[1] === "Target.getTargetInfo") {
      return { targetInfo: target(params[0].tabId) };
    }
    return { ok: true, method };
  });
  m.connectOverCDP(message => sent.push(message));
  return { m, calls, sent };
}

test("the CDP shim refuses to create or close browser tabs", async () => {
  // This is the only place that stops the model from opening arbitrary pages or
  // closing the user's tabs. It is hand-adapted vendor code, so it needs a guard.
  const { m, calls } = model();
  await assert.rejects(m.command("Target.createTarget", { url: "https://evil.example" }),
    /Only explicitly referenced existing tabs/);
  await assert.rejects(m.command("Target.closeTarget", { targetId: "t1" }),
    /Only explicitly referenced existing tabs/);
  assert.deepEqual(calls, [], "a refused command must not reach the extension");
});

test("the CDP shim forwards ordinary commands to the selected tab only", async () => {
  const { m, calls } = model();
  m.onTabCreated({ id: 7, url: "https://example.com" });
  await m.enableAutoAttach();
  const attached = calls.filter(call => call.method === "chrome.debugger.attach");
  assert.equal(attached.length, 1);
  assert.deepEqual(attached[0].params, [{ tabId: 7 }, "1.3"], "the pinned protocol version is used");
  const sessionId = [...m.sessions.values()][0].sessionId;
  await m.command("Runtime.enable", {}, sessionId);
  const forwarded = calls.at(-1);
  assert.equal(forwarded.method, "chrome.debugger.sendCommand");
  assert.deepEqual(forwarded.params[0], { tabId: 7 }, "the command is scoped to the cited tab");
  assert.equal(forwarded.params[1], "Runtime.enable");
});

test("a command for a detached tab is refused rather than silently retargeted", async () => {
  const { m, calls } = model();
  m.onTabCreated({ id: 7, url: "https://example.com" });
  await m.enableAutoAttach();
  const before = calls.length;
  m.onTabRemoved(7);
  await assert.rejects(m.command("Runtime.enable", {}, "pw-tab-1"), /detached/);
  assert.equal(calls.length, before, "no command may be sent for a detached tab");
});

test("the shim answers the CDP handshake without touching the browser", async () => {
  const { m, calls } = model();
  const version = await m.command("Browser.getVersion", {});
  assert.equal(version.protocolVersion, "1.3");
  assert.deepEqual(await m.command("Browser.setDownloadBehavior", {}), {});
  assert.deepEqual(calls, [], "handshake answers are produced locally");
});

test("tab attachment is announced and detachment is announced once", async () => {
  const { m, sent } = model();
  m.onTabCreated({ id: 7, url: "https://example.com" });
  await m.enableAutoAttach();
  assert.equal(sent.filter(message => message.method === "Target.attachedToTarget").length, 1);
  m.detachTab(7);
  m.detachTab(7);
  assert.equal(sent.filter(message => message.method === "Target.detachedFromTarget").length, 1,
    "detaching twice must not emit a second synthetic detach");
});
