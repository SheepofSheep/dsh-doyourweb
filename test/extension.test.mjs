import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { build } from "esbuild";

/** The shipped template: no token, so the extension asks DSH to pair. */
const pairingBundle = await build({ entryPoints: ["extension/background.js"], bundle: true,
  write: false, platform: "browser", format: "iife", plugins: [{ name: "test-unpaired",
    setup(build) {
      build.onLoad({ filter: /[/\\]config\.js$/ }, () => ({
        contents: 'export const config = { port: 43188, token: "" };', loader: "js",
      }));
    },
  }] });
/** A token baked in by hand, which shipped configs before 0.1.3 carried. */
const bundle = await build({ entryPoints: ["extension/background.js"], bundle: true,
  write: false, platform: "browser", format: "iife", plugins: [{ name: "test-paired",
    setup(build) {
      build.onLoad({ filter: /[/\\]config\.js$/ }, () => ({
        contents: 'export const config = { port: 43188, token: "test-token" };', loader: "js",
      }));
    },
  }] });

function event() {
  const listeners = [];
  return { listeners, addListener: fn => listeners.push(fn),
    removeListener: fn => { const index = listeners.indexOf(fn); if (index >= 0) listeners.splice(index, 1); },
    fire: (...args) => [...listeners].map(fn => fn(...args)) };
}

const flush = () => new Promise(resolve => setImmediate(resolve));
let uuidSequence = 0;

function worker(stored = {}, tabs = [], code = bundle.outputFiles[0].text, session = {}) {
  let load;
  const sockets = [], timers = new Map(), detached = [], fetched = [], badges = [], titles = [], alarms = new Map();
  let sequence = 0;
  class Socket {
    static OPEN = 1;
    static CONNECTING = 0;
    constructor(url, protocols) { this.url = url; this.protocols = protocols; this.readyState = 0; this.messages = []; sockets.push(this); }
    open() { this.readyState = 1; this.onopen?.(); }
    send(value) { this.messages.push(JSON.parse(value)); }
    close() { this.readyState = 3; return this.onclose?.(); }
  }
  const noop = async () => {};
  const chrome = {
    extension: { isAllowedFileSchemeAccess: async () => stored.fileAccess === true },
    tabs: { query: async () => tabs, get: async id => tabs.find(tab => tab.id === id),
      onUpdated: event(), onCreated: event(), onRemoved: event(), onActivated: event(), onAttached: event(), onDetached: event() },
    windows: { getAll: async () => [{ id: 1, type: "normal" }], onCreated: event(), onRemoved: event() },
    debugger: { onEvent: event(), onDetach: event(), attach: noop, getTargets: async () => [], sendCommand: async () => ({}), detach: async target => detached.push(target.tabId) },
    action: { setBadgeText: async options => badges.push(options.text), setBadgeBackgroundColor: noop, setTitle: async options => titles.push(options.title) },
    runtime: { onStartup: event(), onInstalled: event(), onMessage: event(), getManifest: () => ({ version: "0.2.3" }), getURL: path => `chrome-extension://test/${path}` },
    alarms: { onAlarm: event(), get: async name => alarms.get(name), create: async (name, value) => alarms.set(name, value) },
    storage: { local: { get: () => new Promise(resolve => { load = resolve; }),
      set: async values => Object.assign(stored, values),
      remove: async keys => { for (const key of [].concat(keys)) delete stored[key]; } },
      session: { get: async () => session, set: async values => Object.assign(session, values) } },
  };
  vm.runInNewContext(code, { chrome, WebSocket: Socket,
    navigator: { userAgent: "Edg/156" }, crypto: { randomUUID: () => `test-id-${++uuidSequence}` },
    setTimeout: (fn, delay) => { const id = ++sequence; timers.set(id, { fn, delay }); return id; },
    setInterval: (fn, delay) => { const id = ++sequence; timers.set(id, { fn, delay, interval: true }); return id; },
    clearTimeout: id => timers.delete(id), clearInterval: id => timers.delete(id), console, URL, AbortSignal,
    btoa, fetch: async url => {
      fetched.push(String(url));
      return new Response(Buffer.from("89504e470d0a1a0a", "hex"));
    },
  });
  return { chrome, sockets, timers, detached, fetched, badges, titles, alarms, stored, initialize: () => load(stored) };
}

test("opening a web tab waits for the selected normal window's committed URL and publishes its inventory", async () => {
  const tabs = [{ id: 5, windowId: 2, title: "Other", url: "https://example.org/" }];
  const running = worker({}, tabs);
  running.chrome.windows.getAll = async () => [{ id: 1, type: "normal" }, { id: 2, type: "normal" }, { id: 3, incognito: true }];
  running.chrome.windows.get = async id => ({ id, type: "normal", incognito: id === 3 });
  const creates = [];
  running.chrome.tabs.create = async options => {
    creates.push(options);
    const pending = { id: 6, windowId: options.windowId, pendingUrl: options.url };
    tabs.push(pending); return pending;
  };
  running.initialize(); await flush();
  const connection = running.sockets[0]; connection.open(); await flush();
  assert.deepEqual(connection.messages.find(message => message.method === "dsh.inventory").params.windows, [{ id: 1 }, { id: 2 }]);
  for (const [id, params] of [[1, [1, "file:///private"]], [2, [1, "http://localhost:43188/manage"]], [3, [3, "https://example.com/"]]]) {
    await connection.onmessage({ data: JSON.stringify({ id, method: "dsh.openTab", params }) });
    assert.match(connection.messages.find(message => message.id === id).error, /HTTP\/HTTPS URL|normal browser window/);
  }
  assert.equal(creates.length, 0);
  const opening = connection.onmessage({ data: JSON.stringify({ id: 4, method: "dsh.openTab", params: [1, "https://example.com/"] }) });
  await flush();
  assert.equal(connection.messages.some(message => message.id === 4), false);
  Object.assign(tabs[1], { title: "New tab", url: creates[0].url });
  delete tabs[1].pendingUrl;
  running.chrome.tabs.onUpdated.fire(6, { url: tabs[1].url }, tabs[1]);
  await opening;
  assert.deepEqual(JSON.parse(JSON.stringify(creates[0])), { windowId: 1, url: "https://example.com/", active: false });
  const responseIndex = connection.messages.findIndex(message => message.id === 4);
  assert.deepEqual(connection.messages[responseIndex].result, { tabId: 6 });
  assert.ok(connection.messages.slice(0, responseIndex).some(message => message.method === "dsh.inventory"
    && message.params.tabs.some(tab => tab.id === 6 && tab.windowId === 1 && tab.revision === 1)));
  await connection.onmessage({ data: JSON.stringify({ id: 5, method: "dsh.tabState", params: [6] }) });
  assert.deepEqual(connection.messages.find(message => message.id === 5).result, { url: "https://example.com/", title: "New tab", windowId: 1, revision: 1 });
});

test("worker restart reconciles only recorded debugger sessions owned by this extension", async () => {
  const session = { browserSession: "browser-lifetime", ownedTabs: [7, 8, 9] };
  const running = worker({}, [], bundle.outputFiles[0].text, session);
  const probed = [];
  running.chrome.debugger.getTargets = async () => [
    { tabId: 7, attached: true }, { tabId: 8, attached: true }, { tabId: 9, attached: false }, { tabId: 10, attached: true },
  ];
  running.chrome.debugger.sendCommand = async target => {
    probed.push(target.tabId);
    if (target.tabId === 8) throw new Error("Debugger is not attached to this extension");
    return {};
  };
  running.initialize(); await flush();
  assert.deepEqual(probed, [7, 8]);
  assert.deepEqual(running.detached, [7], "an attached flag must never authorize detaching another debugger");
  assert.deepEqual(Array.from(session.ownedTabs), []);
  assert.equal(running.sockets.length, 1, "connect only after old consumers have been released");
});

test("existing reconnect alarm keeps its scheduled deadline on worker wake", async () => {
  const running = worker();
  const existing = { scheduledTime: 1234, periodInMinutes: 0.5 };
  running.alarms.set("reconnect", existing);
  running.initialize(); await flush();
  assert.equal(running.alarms.get("reconnect"), existing);
});

test("existing pong reports version and protocol drift without rejecting the connection", async () => {
  const running = worker();
  running.initialize(); await flush();
  const connection = running.sockets[0]; connection.open(); await flush();
  assert.equal(connection.messages.filter(message => message.method === "dsh.ping").length, 1);
  const listener = running.chrome.runtime.onMessage.listeners[0];
  for (const [params, expected] of [
    [undefined, /协议修订不同或主机较旧/],
    [{ version: "0.2.3", protocolRevision: 0 }, /协议修订不同或主机较旧/],
    [{ version: "0.2.2", protocolRevision: 1 }, /版本不同/],
    [{ version: "0.2.3", protocolRevision: 1 }, /^$/],
  ]) {
    await connection.onmessage({ data: JSON.stringify({ method: "dsh.pong", params }) });
    const state = await new Promise(resolve => listener({ type: "status" }, {}, resolve));
    assert.match(state.compatibilityWarning, expected);
    assert.equal(state.connected, true, "compatibility hints must not block a paired bridge");
  }
});

test("sleeping tabs are visible but fail attachment before renderer commands", async () => {
  const running = worker({}, [{ id: 7, url: "https://example.com/", frozen: true }]);
  let attaches = 0;
  running.chrome.debugger.attach = async () => { attaches++; };
  running.initialize(); await flush(); running.sockets[0].open(); await flush();
  const connection = running.sockets[0];
  assert.equal(connection.messages.find(message => message.method === "dsh.inventory").params.tabs[0].frozen, true);
  await connection.onmessage({ data: JSON.stringify({ id: 1, method: "chrome.debugger.attach", params: [{ tabId: 7 }] }) });
  assert.match(connection.messages.at(-1).error, /asleep/);
  assert.equal(attaches, 0);
});

test("browser startup and alarms wait for saved settings without opening the popup", async () => {
  const running = worker({ profile: "saved-profile" });
  assert.equal(running.chrome.runtime.onStartup.listeners.length, 1);
  assert.equal(running.chrome.runtime.onInstalled.listeners.length, 1);
  running.chrome.runtime.onStartup.fire();
  running.chrome.alarms.onAlarm.fire({ name: "reconnect" });
  await flush();
  assert.equal(running.sockets.length, 0, "Connection must not race storage initialization");
  running.initialize();
  await flush();
  assert.equal(running.sockets.length, 1, "Startup must connect exactly once without a popup");
  running.sockets[0].open();
  await flush();
  const inventory = running.sockets[0].messages.find(message => message.method === "dsh.inventory");
  assert.equal(inventory.params.profile, "saved-profile");
  assert.ok([...running.timers.values()].some(timer => timer.interval && timer.delay === 20000));
});

test("local tabs require file access and still exclude incognito and internal pages", async () => {
  for (const allowed of [false, true]) {
    const running = worker({ fileAccess: allowed }, [
      { id: 1, url: "file:///D:/weather.html" }, { id: 2, url: "file:///D:/private.html", incognito: true },
      { id: 3, url: "edge://settings" }, { id: 4, url: "http://localhost:8080" },
    ]);
    running.initialize(); await flush(); running.sockets[0].open(); await flush();
    const rows = running.sockets[0].messages.find(message => message.method === "dsh.inventory").params.tabs;
    assert.deepEqual(Array.from(rows, row => row.id), allowed ? [1, 4] : [4]);
  }
});

test("tab identity survives worker restart but changes with a new browser lifetime", async () => {
  const stored = { profile: "saved-profile" };
  const session = {};
  async function identity(storage) {
    const running = worker(stored, [], bundle.outputFiles[0].text, storage);
    running.initialize();
    await flush();
    running.sockets[0].open();
    await flush();
    return running.sockets[0].messages.find(message => message.method === "dsh.inventory").params.browserSession;
  }
  const first = await identity(session);
  assert.equal(typeof first, "string");
  assert.equal(await identity(session), first, "service-worker restarts must not revoke open tabs");
  assert.notEqual(await identity({}), first, "tab ids may be reused after a full browser restart");
});

test("a saved pause survives startup and reconnect alarms", async () => {
  const paused = worker({ stopped: true });
  paused.chrome.alarms.onAlarm.fire({ name: "reconnect" });
  await flush();
  assert.equal(paused.sockets.length, 0);
  paused.initialize();
  await flush();
  paused.chrome.runtime.onStartup.fire();
  await flush();
  assert.equal(paused.sockets.length, 0);
});

test("tab icons come from the browser cache without fetching websites", async () => {
  const running = worker({}, [{ id: 1, url: "https://example.com/", title: "Example",
    favIconUrl: "https://example.com/favicon.ico" }]);
  running.initialize();
  await flush();
  running.sockets[0].open();
  await flush();
  const inventory = running.sockets[0].messages.filter(message => message.method === "dsh.inventory").at(-1);
  assert.match(inventory.params.tabs[0].favicon, /^data:image\/png;base64,/);
  assert.equal(running.fetched.length, 1);
  assert.match(running.fetched[0], /^chrome-extension:\/\/test\/_favicon\//);
  running.chrome.tabs.onUpdated.fire();
  const timer = [...running.timers.values()].find(timer => timer.delay === 150);
  timer.fn();
  await flush();
  assert.equal(running.fetched.length, 1, "Repeated inventory must reuse the cached icon");
});

test("disconnect releases control and reconnects without popup; pause remains respected", async () => {
  const running = worker({ token: "paired-token" }, [{ id: 7, url: "https://example.com/" }]);
  running.initialize();
  await flush();
  const connection = running.sockets[0];
  assert.deepEqual([...connection.protocols], ["dsh-browser", "paired-token"]);
  connection.open();
  await connection.onmessage({ data: JSON.stringify({ id: 1, method: "chrome.debugger.attach", params: [{ tabId: 7 }] }) });
  await connection.close();
  assert.deepEqual(running.detached, [7]);
  const retry = [...running.timers.values()].find(timer => !timer.interval && timer.delay === 1000);
  assert.ok(retry, "Connection loss must schedule an automatic retry");
  retry.fn();
  await flush();
  assert.equal(running.sockets.length, 2);
  running.sockets[1].open();
  assert.equal([...running.timers.values()].filter(timer => timer.interval).length, 1);
  const listener = running.chrome.runtime.onMessage.listeners[0];
  await new Promise(resolve => { assert.equal(listener({ type: "toggle", stopped: true }, {}, resolve), true); });
  running.chrome.alarms.onAlarm.fire({ name: "reconnect" });
  await flush();
  assert.equal(running.sockets.length, 2);
  const status = await new Promise(resolve => listener({ type: "status" }, {}, resolve));
  assert.equal(status.stopped, true);
  assert.equal(status.connected, false);
  assert.equal(status.controlledTabs, 0);
  await new Promise(resolve => listener({ type: "toggle", stopped: false }, {}, resolve));
  assert.equal(running.sockets.length, 3);
});

test("an unpaired extension shows its code, stores the handed token, and reconnects authenticated", async () => {
  const running = worker({}, [], pairingBundle.outputFiles[0].text);
  running.initialize();
  await flush();
  assert.equal(running.sockets.length, 1);
  const pairing = running.sockets[0];
  assert.deepEqual([...pairing.protocols], ["dsh-browser"], "no token means the socket asks to pair");
  pairing.open();
  await pairing.onmessage({ data: JSON.stringify({ method: "dsh.pairing",
    params: { id: "abc12345", code: "4821", expiresAt: Date.now() + 60000, port: 43188 } }) });
  await flush();
  // A badge holds ~4 characters, so a 6-digit code is shown in the popup and the
  // tooltip; rendering a truncated prefix would defeat the comparison.
  assert.equal(running.badges.at(-1), "PAIR", "the badge signals pairing without truncating the code");
  assert.match(running.titles.at(-1) ?? "", /4821/, "the tooltip carries the full code the user compares");
  const listener = running.chrome.runtime.onMessage.listeners[0];
  const status = await new Promise(resolve => listener({ type: "status" }, {}, resolve));
  assert.equal(status.paired, false);
  assert.equal(status.pairing.code, "4821");
  assert.equal(status.connected, false);
  await pairing.onmessage({ data: JSON.stringify({ method: "dsh.paired", params: { token: "fresh-token", port: 43188 } }) });
  await flush();
  assert.equal(running.stored.token, "fresh-token");
  assert.equal(pairing.readyState, 3, "the pairing socket is closed after handing over the token");
  [...running.timers.values()].find(timer => !timer.interval && timer.delay === 1000).fn();
  await flush();
  assert.equal(running.sockets.length, 2, "the extension reconnects with the stored token");
  assert.deepEqual([...running.sockets[1].protocols], ["dsh-browser", "fresh-token"]);
  running.sockets[1].open();
  await flush();
  assert.equal(running.badges.at(-1), "", "the pairing badge is cleared once paired and connected");
});

test("unpaired tab updates disclose no inventory and an expired socket requests a new code", async () => {
  const running = worker({}, [{ id: 7, title: "Private", url: "https://example.com" }], pairingBundle.outputFiles[0].text);
  running.initialize();
  await flush();
  const connection = running.sockets[0];
  connection.open();
  running.chrome.tabs.onUpdated.fire();
  [...running.timers.values()].find(timer => timer.delay === 150).fn();
  await flush();
  assert.equal(connection.messages.some(message => message.method === "dsh.inventory"), false);
  await connection.onmessage({ data: JSON.stringify({ method: "dsh.pairing",
    params: { code: "1234", expiresAt: Date.now() + 1000 } }) });
  await connection.close();
  const listener = running.chrome.runtime.onMessage.listeners[0];
  const status = await new Promise(resolve => listener({ type: "status" }, {}, resolve));
  assert.equal(status.pairing, undefined);
  [...running.timers.values()].find(timer => !timer.interval && timer.delay === 1000).fn();
  await flush();
  assert.equal(running.sockets.length, 2);
  assert.deepEqual([...running.sockets[1].protocols], ["dsh-browser"]);
});

test("unpairing clears the stored token and returns the extension to pairing", async () => {
  const running = worker({ token: "paired-token" });
  running.initialize();
  await flush();
  running.sockets[0].open();
  const listener = running.chrome.runtime.onMessage.listeners[0];
  await new Promise(resolve => listener({ type: "unpair" }, {}, resolve));
  await flush();
  assert.equal(running.stored.token, undefined);
  assert.equal(running.sockets.length, 2);
  assert.deepEqual([...running.sockets[1].protocols], ["dsh-browser"]);
});

test("the port is configurable and a bad port is refused", async () => {
  const running = worker({ token: "paired-token" });
  running.initialize();
  await flush();
  assert.match(running.sockets[0].url, /:43188\/extension$/);
  const listener = running.chrome.runtime.onMessage.listeners[0];
  const failed = await new Promise(resolve => listener({ type: "port", port: 70000 }, {}, resolve));
  assert.match(failed.error, /1-65535/);
  await new Promise(resolve => listener({ type: "port", port: 43200 }, {}, resolve));
  await flush();
  assert.equal(running.stored.port, 43200);
  assert.match(running.sockets.at(-1).url, /:43200\/extension$/);
});

