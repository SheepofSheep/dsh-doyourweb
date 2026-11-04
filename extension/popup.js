const enabled = document.querySelector("#enabled");
const status = document.querySelector("#status");
const pairing = document.querySelector("#pairing");
const code = document.querySelector("#code");
const port = document.querySelector("#port");
const savePort = document.querySelector("#save-port");
const unpair = document.querySelector("#unpair");
document.querySelector("#setup").addEventListener("click", async () => {
  try {
    const state = await chrome.runtime.sendMessage({ type: "status" });
    const selectedPort = state.port ?? 43187;
    if (!Number.isSafeInteger(selectedPort) || selectedPort < 1 || selectedPort > 65535) throw new Error("连接端口无效");
    await chrome.tabs.create({ url: `http://127.0.0.1:${selectedPort}/setup` });
  } catch (error) { showError(error); }
});
document.querySelector("#file-access").textContent = await chrome.extension.isAllowedFileSchemeAccess()
  ? "已允许引用本地 HTML 页面" : "引用本地 HTML：请在浏览器扩展详情中开启“允许访问文件网址”。";

async function refresh() {
  const state = await chrome.runtime.sendMessage({ type: "status" });
  if (state.error) throw new Error(state.error);
  const waiting = state.pairing !== undefined && !state.stopped;
  enabled.checked = !state.stopped;
  if (document.activeElement !== port) port.value = String(state.port ?? 43187);
  unpair.hidden = !state.paired;
  pairing.hidden = !waiting;
  document.querySelector("#setup").hidden = state.connected;
  code.textContent = state.pairing?.code ?? "";
  status.dataset.state = state.connected ? "connected" : waiting ? "waiting" : "offline";
  document.querySelector("#annotate").disabled = !state.connected;
  document.querySelector("#annotate").title = state.connected ? "选择当前页面元素，批注后加入聊天草稿" : "连接 DSH 后即可批注当前页面";
  status.textContent = waiting ? "\u7b49\u5f85 DSH \u786e\u8ba4\u4e0b\u9762\u7684\u9a8c\u8bc1\u7801"
    : state.connected ? `\u5df2\u8fde\u63a5 \u00b7 ${state.availableTabs} \u4e2a\u6807\u7b7e\u9875 \u00b7 ${state.controlledTabs} \u4e2a\u53d7\u63a7`
      : state.stopped ? "\u5df2\u6682\u505c" : state.paired ? "\u7b49\u5f85 DSH" : "\u672a\u914d\u5bf9";
}

function showError(error) { status.dataset.state = "error"; status.textContent = error.message; }
for (const type of ["annotate", "manage"]) document.querySelector(`#${type}`).addEventListener("click", () => {
  void send({ type }).catch(showError);
});

async function send(message) {
  const result = await chrome.runtime.sendMessage(message);
  if (result.error) throw new Error(result.error);
  await refresh();
}

enabled.addEventListener("change", async () => {
  enabled.disabled = true;
  try { await send({ type: "toggle", stopped: !enabled.checked }); }
  catch (error) { showError(error); }
  finally { enabled.disabled = false; }
});
savePort.addEventListener("click", async () => {
  if (!port.reportValidity()) return;
  try { await send({ type: "port", port: Number(port.value) }); }
  catch (error) { showError(error); }
});
unpair.addEventListener("click", async () => {
  try { await send({ type: "unpair" }); }
  catch (error) { showError(error); }
});

await refresh().catch(showError);
const timer = setInterval(() => void refresh().catch(showError), 2000);
window.addEventListener("pagehide", () => clearInterval(timer), { once: true });
