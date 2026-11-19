const enabled = document.querySelector("#enabled");
const status = document.querySelector("#status");
const pairing = document.querySelector("#pairing");
const code = document.querySelector("#code");
const port = document.querySelector("#port");
const savePort = document.querySelector("#save-port");
const unpair = document.querySelector("#unpair");
const stop = document.querySelector("#stop-operation");
const annotate = document.querySelector("#annotate");
const pageFeedback = document.querySelector("#page-feedback");
let pageActionPending = false;
let connected = false;
let refreshPending = false;
document.querySelector("#setup").addEventListener("click", async () => {
  try {
    const state = await chrome.runtime.sendMessage({ type: "status" });
    const selectedPort = state.port ?? 43187;
    if (!Number.isSafeInteger(selectedPort) || selectedPort < 1 || selectedPort > 65535) throw new Error("连接端口无效");
    await chrome.tabs.create({ url: `http://127.0.0.1:${selectedPort}/setup` });
  } catch (error) { showError(error); }
});
// A rejected probe must not abort module evaluation: everything below this point
// is listener registration, and a top-level throw would leave every control inert.
chrome.extension.isAllowedFileSchemeAccess().catch(() => false).then(allowed => {
  document.querySelector("#file-access").textContent = allowed
    ? "已允许引用本地 HTML 页面" : "引用本地 HTML：请在浏览器扩展详情中开启“允许访问文件网址”。";
});

async function refresh() {
  if (refreshPending) return;
  refreshPending = true;
  try {
    const state = await chrome.runtime.sendMessage({ type: "status" });
    if (state.error) throw new Error(state.error);
    connected = state.connected;
    const compatibility = document.querySelector("#compatibility");
    compatibility.hidden = !state.compatibilityWarning;
    compatibility.textContent = state.compatibilityWarning || "";
    document.querySelector("#version").textContent = `扩展 ${chrome.runtime.getManifest().version} · 主机 ${state.connected ? state.hostVersion || "等待版本信息" : "未连接"}`;
    stop.disabled = annotate.disabled = pageActionPending || !connected;
    const waiting = state.pairing !== undefined && !state.stopped;
    // Do not fight the user's own toggle while its request is in flight.
    if (!enabled.disabled) enabled.checked = !state.stopped;
    if (document.activeElement !== port) port.value = String(state.port ?? 43187);
    unpair.hidden = !state.paired;
    pairing.hidden = !waiting;
    document.querySelector("#setup").hidden = state.connected;
    code.textContent = state.pairing?.code ?? "";
    annotate.title = state.connected ? "在当前标签页开始批注或恢复编辑" : "连接 DSH 后即可批注当前页面";
    // An error the user just triggered stays visible until the next action; the
    // 2 s poll would otherwise erase it before it could be read.
    if (statusError) return;
    status.dataset.state = state.connected ? "connected" : waiting ? "waiting" : "offline";
    status.textContent = waiting ? "等待 DSH 确认验证码"
      : state.connected ? `已连接 · ${state.availableTabs} 个标签页 · ${state.controlledTabs} 个受控`
        : state.stopped ? "已暂停" : state.paired ? "等待 DSH" : "未配对";
  } finally { refreshPending = false; }
}

let statusError = false;
function showError(error) {
  statusError = true;
  status.dataset.state = "error"; status.textContent = error.message;
}
for (const [button, type] of [[annotate, "annotate"], [stop, "stop-operation"]]) button.addEventListener("click", async () => {
  const opening = button === annotate;
  pageActionPending = true;
  stop.disabled = annotate.disabled = true;
  pageFeedback.hidden = false;
  pageFeedback.textContent = opening ? "正在打开批注…" : "正在请求停止…";
  try {
    const result = await chrome.runtime.sendMessage({ type });
    if (result.error) throw new Error(result.error);
    pageFeedback.textContent = opening ? "批注工具已打开。" : result.stopped ? "已请求停止当前页操作" : "当前页没有正在运行的操作";
    if (opening) window.close();
  } catch (error) { pageFeedback.textContent = error.message; }
  finally { pageActionPending = false; stop.disabled = annotate.disabled = !connected; }
});
document.querySelector("#manage").addEventListener("click", () => void send({ type: "manage" }).catch(showError));

async function send(message) {
  statusError = false;
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
// Each tick wakes the MV3 worker, so poll only while the popup is actually visible
// and stop as soon as it is hidden.
let timer;
const startPolling = () => { clearInterval(timer); timer = setInterval(() => void refresh().catch(showError), 2000); };
const stopPolling = () => clearInterval(timer);
document.addEventListener("visibilitychange", () => document.hidden ? stopPolling() : startPolling());
window.addEventListener("pagehide", stopPolling, { once: true });
if (!document.hidden) startPolling();
