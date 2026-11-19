import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

test("popup remains usable after file access rejection and preserves action errors across polls", async () => {
  const source = await readFile(new URL("../extension/popup.js", import.meta.url), "utf8");
  const elements = new Map();
  const element = selector => {
    if (!elements.has(selector)) elements.set(selector, { dataset: {}, listeners: {}, value: "43187", reportValidity: () => true,
      addEventListener(type, listener) { this.listeners[type] = listener; } });
    return elements.get(selector);
  };
  let poll;
  const document = { querySelector: element, hidden: false, addEventListener() {} };
  const state = { connected: true, availableTabs: 2, controlledTabs: 0, port: 43187 };
  const context = { document, window: { addEventListener() {} }, console,
    chrome: { runtime: { getManifest: () => ({ version: "0.2.3" }), sendMessage: async message => message.type === "port" ? { error: "保存失败，请检查端口" } : state },
      extension: { isAllowedFileSchemeAccess: async () => { throw new Error("permission denied"); } } },
    setInterval: callback => { poll = callback; return 1; }, clearInterval() {} };
  await vm.runInNewContext(`(async () => {${source}\n})()`, context);
  assert.match(element("#file-access").textContent, /允许访问文件网址/);
  assert.equal(typeof element("#enabled").listeners.change, "function");
  assert.equal(element("#annotate").disabled, false);
  state.compatibilityWarning = "主机与扩展版本不同，请同步更新。";
  poll(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(element("#compatibility").hidden, false);
  assert.match(element("#compatibility").textContent, /请同步更新/);
  state.compatibilityWarning = "";
  poll(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(element("#compatibility").hidden, true);
  await element("#save-port").listeners.click();
  assert.match(element("#status").textContent, /保存失败/);
  poll(); await new Promise(resolve => setImmediate(resolve));
  assert.match(element("#status").textContent, /保存失败/, "successful status polling must not erase an action error");
  await element("#enabled").listeners.change();
  assert.match(element("#status").textContent, /已连接/);
});
