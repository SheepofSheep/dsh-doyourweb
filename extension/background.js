import { config } from "./config.js";

let socket;
let profile;
let browserSession;
let timer;
let retryTimer;
let ready;
let cleanup = Promise.resolve();
let retry = 1000;
let stopped = false;
let inventoryTimer;
let availableTabs = 0;
let inventoryGeneration = 0;
// Pairing state: the token is stored in browser storage, never in a shipped file,
// and is only accepted from the DSH setup page after the user compares its code.
let token = config.token || "";
let port = config.port || 43187;
let pairing;
const favicons = new Map();
const attached = new Set();
const browser = navigator.userAgent.includes("Edg/") ? "Edge" : "Chrome";

function send(message, connection = socket) {
  if (connection?.readyState === WebSocket.OPEN) connection.send(JSON.stringify(message));
}
let fileAccess = false;
function supported(tab) { return !tab.incognito && (/^https?:\/\//.test(tab.url || "") || (fileAccess && /^file:\/\//.test(tab.url || ""))); }

function faviconKey(tab) { return `${tab.url}\n${tab.favIconUrl || ""}`; }

async function cachedFavicon(tab) {
  const key = faviconKey(tab);
  if (favicons.has(key)) return favicons.get(key).pending;
  const entry = {};
  entry.pending = (async () => {
    try {
      const url = new URL(chrome.runtime.getURL("_favicon/"));
      url.searchParams.set("pageUrl", tab.url);
      url.searchParams.set("size", "16");
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (!response.ok) return;
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length > 8192) return;
      // Chromium's cached favicon endpoint can omit Content-Type.
      if ([137, 80, 78, 71, 13, 10, 26, 10].some((byte, index) => bytes[index] !== byte)) return;
      entry.image = `data:image/png;base64,${btoa(String.fromCharCode(...bytes))}`;
      return entry.image;
    } catch { /* Sites without a cached favicon use the DSH globe icon. */ }
  })();
  favicons.set(key, entry);
  return entry.pending;
}

async function inventory() {
  const connection = socket;
  if (!token || connection?.readyState !== WebSocket.OPEN) return;
  const generation = ++inventoryGeneration;
  fileAccess = await chrome.extension.isAllowedFileSchemeAccess();
  const tabs = (await chrome.tabs.query({})).filter(supported);
  if (socket !== connection || generation !== inventoryGeneration) return;
  availableTabs = tabs.length;
  const liveKeys = new Set(tabs.map(faviconKey));
  for (const key of favicons.keys()) if (!liveKeys.has(key)) favicons.delete(key);
  const rows = tabs.map(tab => ({
    id: tab.id, title: tab.title, url: tab.url, windowId: tab.windowId, active: tab.active,
    lastAccessed: tab.lastAccessed, incognito: false, favicon: favicons.get(faviconKey(tab))?.image,
  }));
  // Publish metadata immediately; local icon reads must not delay tab discovery.
  send({ method: "dsh.inventory", params: { profile, browserSession, browser, tabs: rows } }, connection);
  const images = await Promise.all(tabs.map(cachedFavicon));
  if (socket !== connection || generation !== inventoryGeneration) return;
  if (images.some((image, index) => image !== rows[index].favicon)) {
    send({ method: "dsh.inventory", params: { profile, browserSession, browser,
      tabs: rows.map((tab, index) => ({ ...tab, favicon: images[index] })) } }, connection);
  }
}

function scheduleInventory() {
  clearTimeout(inventoryTimer);
  inventoryTimer = setTimeout(() => void inventory().catch(console.warn), 150);
}

async function command(message, connection) {
  const args = message.params || [];
  const target = args[0];
  switch (message.method) {
    case "chrome.debugger.attach": {
      const tab = await chrome.tabs.get(target.tabId);
      fileAccess = await chrome.extension.isAllowedFileSchemeAccess();
      if (!supported(tab)) throw new Error("Use a regular web or local file tab; enable Allow access to file URLs in extension details for local pages");
      if (!attached.has(target.tabId)) {
        await chrome.debugger.attach(target, "1.3");
        if (socket !== connection || stopped) {
          await chrome.debugger.detach(target).catch(() => {});
          throw new Error("Browser bridge disconnected during attachment");
        }
        attached.add(target.tabId);
        await chrome.action.setBadgeText({ tabId: target.tabId, text: "DSH" });
        await chrome.action.setBadgeBackgroundColor({ tabId: target.tabId, color: "#237841" });
      }
      return {};
    }
    case "chrome.debugger.detach":
      if (attached.delete(target.tabId)) {
        await chrome.debugger.detach(target).catch(() => {});
        await chrome.action.setBadgeText({ tabId: target.tabId, text: "" }).catch(() => {});
      }
      return {};
    case "chrome.debugger.sendCommand":
      if (!attached.has(target.tabId)) throw new Error("Tab is not attached");
      return chrome.debugger.sendCommand(target, args[1], args[2]);
    case "dsh.focus": {
      const tab = await chrome.tabs.get(target);
      if (!supported(tab)) throw new Error("Tab is unsupported");
      await chrome.tabs.update(tab.id, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
      return {};
    }
    default: throw new Error("Unsupported browser bridge command");
  }
}

function disconnect() {
  const connection = socket;
  socket = undefined;
  pairing = undefined;
  clearInterval(timer);
  clearTimeout(retryTimer);
  clearTimeout(inventoryTimer);
  connection?.close();
  const tabIds = [...attached];
  attached.clear();
  cleanup = cleanup.then(() => Promise.all(tabIds.map(async tabId => {
    await chrome.debugger.detach({ tabId }).catch(() => {});
    await chrome.action.setBadgeText({ tabId, text: "" }).catch(() => {});
  })));
  void updateStatus();
  return cleanup;
}

async function updateStatus() {
  const connected = !!token && socket?.readyState === WebSocket.OPEN && !pairing;
  const title = stopped ? "\u5df2\u6682\u505c"
    : pairing ? `\u914d\u5bf9\u4e2d \u00b7 ${pairing.code}`
      : !token ? "\u672a\u914d\u5bf9" : connected ? "\u5df2\u8fde\u63a5" : "\u7b49\u5f85 DSH";
  await chrome.action.setTitle({ title: `DSH DoYourWeb - ${title}` });
  // While unpaired the badge is the code the user compares with the DSH setup page.
  await chrome.action.setBadgeText({ text: pairing ? pairing.code : connected || stopped ? "" : "OFF" });
  await chrome.action.setBadgeBackgroundColor({ color: pairing ? "#b45309" : "#6b7280" });
}

async function connect() {
  await ready;
  await cleanup;
  if (stopped || socket && [WebSocket.OPEN, WebSocket.CONNECTING].includes(socket.readyState)) return;
  clearTimeout(retryTimer);
  // No token means "please pair me"; the bridge answers with a code to confirm.
  const protocols = token ? ["dsh-browser", token] : ["dsh-browser"];
  const connection = new WebSocket(`ws://127.0.0.1:${port}/extension`, protocols);
  socket = connection;
  connection.onopen = () => {
    if (socket !== connection) return connection.close();
    retry = 1000;
    pairing = undefined;
    void updateStatus();
    if (token) void inventory().catch(console.warn);
    timer = setInterval(() => send({ method: "dsh.ping" }, connection), 20000);
  };
  connection.onmessage = async event => {
    if (socket !== connection) return;
    let message;
    try {
      message = JSON.parse(event.data);
      if (message.method === "dsh.pairing") {
        pairing = message.params;
        void updateStatus();
        return;
      }
      if (message.method === "dsh.paired") {
        token = message.params.token;
        port = message.params.port || port;
        pairing = undefined;
        retry = 1000;
        await chrome.storage.local.set({ token, port });
        void updateStatus();
        connection.close();
        return;
      }
      if (!Number.isSafeInteger(message.id)) return;
      const diagnostic = phase => { if (message.diagnostics === true) send({ method: "dsh.diagnostic",
        params: { id: message.id, phase, version: chrome.runtime.getManifest().version } }, connection); };
      diagnostic("extension_receive");
      // finally also reports API rejection; raw errors stay in the existing command response only.
      let result;
      try { result = await command(message, connection); }
      finally { diagnostic("api_settle"); }
      diagnostic("extension_response");
      send({ id: message.id, result: result ?? {} }, connection);
    } catch (error) { if (message?.id) send({ id: message.id, error: error.message }, connection); }
  };
  connection.onerror = () => {};
  connection.onclose = async () => {
    if (socket !== connection) return;
    await disconnect();
    if (!stopped && !socket) {
      retryTimer = setTimeout(() => void connect().catch(console.warn), retry);
      retry = Math.min(30000, retry * 2);
    }
  };
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (attached.has(source.tabId)) send({ method: "chrome.debugger.onEvent", params: [source, method, params] });
});
chrome.debugger.onDetach.addListener((source, reason) => {
  const controlled = attached.delete(source.tabId);
  void chrome.action.setBadgeText({ tabId: source.tabId, text: "" }).catch(() => {});
  if (controlled) send({ method: "chrome.debugger.onDetach", params: [source, reason] });
});
chrome.tabs.onUpdated.addListener(scheduleInventory);
chrome.tabs.onCreated.addListener(scheduleInventory);
chrome.tabs.onRemoved.addListener(scheduleInventory);
chrome.tabs.onActivated.addListener(scheduleInventory);
const reconnect = () => { void connect().catch(console.warn); };
chrome.runtime.onStartup.addListener(reconnect);
chrome.runtime.onInstalled.addListener(reconnect);
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === "reconnect") reconnect(); });
chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  if (_sender.id !== chrome.runtime.id || (_sender.url && _sender.url !== chrome.runtime.getURL("popup.html"))) return;
  if (!["status", "toggle", "unpair", "port", "annotate", "manage"].includes(message.type)) return;
  void (async () => {
    await ready;
    if (message.type === "manage") { await chrome.tabs.create({ url: `http://127.0.0.1:${port}/manage` }); respond({ ok: true }); return; }
    if (message.type === "annotate") {
      if (!token || socket?.readyState !== WebSocket.OPEN || pairing) throw new Error("请先连接 DSH");
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      fileAccess = await chrome.extension.isAllowedFileSchemeAccess();
      if (!tab || !supported(tab)) throw new Error("请选择网页或本地 HTML；本地页面需在扩展详情中开启“允许访问文件网址”");
      send({ method: "dsh.annotation.start", params: { tabId: tab.id } }); respond({ ok: true }); return;
    }
    if (message.type === "status") {
      respond({ connected: !!token && socket?.readyState === WebSocket.OPEN && !pairing,
        availableTabs, controlledTabs: attached.size, stopped, paired: !!token,
        pairing: pairing === undefined ? undefined : { code: pairing.code, expiresAt: pairing.expiresAt },
        port });
      return;
    }
    if (message.type === "unpair") {
      token = "";
      pairing = undefined;
      await chrome.storage.local.remove(["token"]);
      await disconnect();
      await connect();
      await updateStatus();
      respond({ ok: true });
      return;
    }
    if (message.type === "port") {
      const next = Number(message.port);
      if (!Number.isSafeInteger(next) || next < 1 || next > 65535) throw new Error("端口必须是 1-65535 之间的整数");
      port = next;
      await chrome.storage.local.set({ port });
      await disconnect();
      await connect();
      respond({ ok: true });
      return;
    }
    stopped = message.stopped === true;
    await chrome.storage.local.set({ stopped });
    if (stopped) await disconnect(); else await connect();
    await updateStatus();
    respond({ ok: true });
  })().catch(error => respond({ error: error.message }));
  return true;
});

// MV3 service workers register listeners synchronously and cannot use top-level await.
ready = (async () => {
  const stored = await chrome.storage.local.get(["profile", "stopped", "token", "port"]);
  profile = stored.profile || crypto.randomUUID();
  // Session storage survives worker suspension, but never a full browser restart.
  const session = await chrome.storage.session.get(["browserSession"]);
  browserSession = session.browserSession || crypto.randomUUID();
  await chrome.storage.session.set({ browserSession });
  stopped = stored.stopped === true;
  token = stored.token || config.token || "";
  port = stored.port || config.port || 43187;
  await chrome.storage.local.set({ profile });
  await chrome.alarms.create("reconnect", { periodInMinutes: 0.5 });
  await updateStatus();
})();
reconnect();
