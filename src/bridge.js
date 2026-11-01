import http from "node:http";
import { EventEmitter } from "node:events";
import { randomUUID, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import { chromium } from "playwright-core";
import { BrowserModel } from "./vendor/browser-model.js";
import { extensionId, Pairings, pinnedExtensionId } from "./pairing.js";
import { canControl, parseRef, tabRef } from "./protocol.js";
import { managementPage } from "./manage.js";
import { Diagnostics } from "./diagnostics.js";

export { extensionId } from "./pairing.js";

export function sameSecret(actual, expected) {
  const a = Buffer.from(actual || ""), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export class BrowserBridge extends EventEmitter {
  constructor({ home, port = 43187, extensionSource, idleTimeoutMs = 120000, diagnostics = new Diagnostics() } = {}) {
    super();
    this.home = home;
    this.port = port;
    this.extensionSource = extensionSource || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../extension");
    this.profiles = new Map();
    this.relays = new Map();
    this.pending = new Map();
    this.detachments = new Map();
    this.idleTimeoutMs = idleTimeoutMs;
    this.pairings = new Pairings();
    this.setupKey = randomBytes(16).toString("hex");
    this.sequence = 0;
    this.diagnostics = diagnostics;
  }

  /**
   * Load the pairing token and the extension identity. The companion extension is
   * loaded by the user straight from `extension/`, which pins its own manifest key,
   * so nothing is generated or copied into it; only the token lives in `home`.
   */
  async prepareExtension() {
    await mkdir(this.home, { recursive: true });
    const settingsPath = path.join(this.home, "pairing.json");
    try { this.settings = JSON.parse(await readFile(settingsPath, "utf8")); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      this.settings = { token: randomBytes(32).toString("hex") };
      await writeFile(settingsPath, JSON.stringify(this.settings), { mode: 0o600, flag: "wx" });
    }
    if (!/^[0-9a-f]{64}$/.test(this.settings.token ?? "")) {
      throw new Error("pairing.json has no usable token; delete it and restart the plugin to pair the extension again");
    }
    this.extensionPath = this.extensionSource;
    this.manifest = JSON.parse(await readFile(path.join(this.extensionSource, "manifest.json"), "utf8"));
    this.id = pinnedExtensionId(this.manifest);
    // Installations created before 0.1.3 loaded a generated copy pinned to a
    // per-install key; keep accepting that origin so they keep working.
    this.legacyId = typeof this.settings.key === "string" && this.settings.key.length ? extensionId(this.settings.key) : undefined;
  }

  /** Whether a WebSocket origin may talk to this bridge at all. */
  trustedOrigin(origin) {
    return origin === `chrome-extension://${this.id}` || (this.legacyId !== undefined && origin === `chrome-extension://${this.legacyId}`);
  }

  async start() {
    await this.prepareExtension();
    this.server = http.createServer((request, response) => this.handleHttp(request, response));
    this.ws = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });
    this.server.on("upgrade", (request, socket, head) => {
      if (request.headers.host !== `127.0.0.1:${this.port}`) return socket.destroy();
      const pathname = new URL(request.url, "http://127.0.0.1").pathname;
      if (pathname === "/extension") {
        const protocols = (request.headers["sec-websocket-protocol"] || "").split(",").map(s => s.trim());
        if (!this.trustedOrigin(request.headers.origin)) return socket.destroy();
        // A token means an already paired browser; its absence asks for pairing.
        if (sameSecret(protocols[1], this.settings.token)) this.ws.handleUpgrade(request, socket, head, ws => this.acceptExtension(ws));
        else if (protocols[1] === undefined && request.headers.origin === `chrome-extension://${this.id}`) {
          this.ws.handleUpgrade(request, socket, head, ws => this.acceptPairing(ws));
        } else socket.destroy();
      } else {
        const relay = this.relays.get(pathname);
        if (!relay || request.headers.origin || !sameSecret(request.headers.authorization, `Bearer ${this.settings.token}`) || relay.ws) return socket.destroy();
        this.ws.handleUpgrade(request, socket, head, ws => this.acceptCDP(relay, ws));
      }
    });
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.port, "127.0.0.1", resolve);
    }).catch(error => {
      if (error.code !== "EADDRINUSE") throw error;
      throw new Error(`Browser bridge port ${this.port} is already in use. Another DSH instance, another application, or a bridge leaked by an older plugin version owns it; stop that instance or set a different "port" in the plugin settings.`);
    });
    this.port = this.server.address().port;
    this.url = `http://127.0.0.1:${this.port}/setup`;
  }

  /** Hand the token to the extension whose pairing request the user approved. */
  approvePairing(id) {
    const pairing = this.pairings.take(id);
    if (pairing === undefined) return false;
    if (pairing.socket.readyState !== WebSocket.OPEN) return false;
    pairing.socket.send(JSON.stringify({ method: "dsh.paired", params: { token: this.settings.token, port: this.port } }));
    // The extension stores the token and reconnects authenticated, so this
    // request-only socket never becomes a control channel.
    pairing.socket.close(1000, "Paired");
    return true;
  }

  acceptPairing(ws) {
    const pairing = this.pairings.request(ws);
    if (pairing === undefined) return ws.close(1008, "Too many pairing requests");
    ws.on("error", () => {});
    const expiry = setTimeout(() => {
      this.pairings.drop(ws);
      ws.close(1000, "Pairing expired");
    }, this.pairings.ttlMs);
    expiry.unref();
    ws.on("close", () => { clearTimeout(expiry); this.pairings.drop(ws); });
    ws.send(JSON.stringify({ method: "dsh.pairing", params: {
      id: pairing.id, code: pairing.code, expiresAt: pairing.expires, port: this.port,
    } }));
  }

  handleHttp(request, response) {
    if (request.headers.host !== `127.0.0.1:${this.port}`) { response.writeHead(403).end(); return; }
    const pathname = new URL(request.url, "http://127.0.0.1").pathname;
    if (pathname === "/manage/api" && request.method === "POST") return this.handleManagement(request, response);
    if (request.method === "POST" && pathname === "/setup/pair") return this.handlePairPost(request, response);
    if (request.method !== "GET") { response.writeHead(405).end(); return; }
    if (pathname === "/manage") {
      const { html, nonce } = managementPage(this.setupKey);
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer",
        "Content-Security-Policy": `default-src 'none'; connect-src 'self'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; base-uri 'none'; frame-ancestors 'none'` });
      response.end(html); return;
    }
    if (pathname !== "/setup") { response.writeHead(404).end(); return; }
    // The CSP nonce is minted per response: the only script the page may run is the
    // one behind the copy buttons, because a browser refuses web-page navigation to
    // `chrome://`/`edge://`, so opening the extension manager stays a user action.
    const nonce = randomBytes(16).toString("base64");
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store",
      "Content-Security-Policy": `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; base-uri 'none'; frame-ancestors 'none'` });
    response.end(this.setupPage(nonce));
  }

  handleManagement(request, response) {
    const origin = `http://127.0.0.1:${this.port}`;
    if (!sameSecret(request.headers["x-dsh-key"], this.setupKey)
      || (request.headers.origin && request.headers.origin !== origin)
      || (request.headers["sec-fetch-site"] && request.headers["sec-fetch-site"] !== "same-origin")
      || request.headers["content-type"]?.split(";")[0] !== "application/json") { response.writeHead(403).end(); return; }
    let body = "", oversized = false;
    request.on("data", chunk => { body += chunk; if (Buffer.byteLength(body) > 65536) { oversized = true; response.writeHead(413).end(); request.destroy(); } });
    request.on("end", async () => {
      if (oversized) return;
      try {
        if (!this.management) throw new Error("Management service is not ready");
        const result = await this.management(JSON.parse(body));
        response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify(result));
      } catch (error) {
        if (!response.headersSent) response.writeHead(400, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify({ error: error.message }));
      }
    });
  }

  setupPage(nonce) {
    const pending = this.pairings.list();
    const requests = pending.map(entry => `<li><strong>&#39564;&#35777;&#30721; ${escapeHtml(entry.code)}</strong>
      <form method="post" action="/setup/pair"><input type="hidden" name="key" value="${escapeHtml(this.setupKey)}">
      <input type="hidden" name="id" value="${escapeHtml(entry.id)}">
      <button name="action" value="allow">&#20801;&#35768;</button>
      <button name="action" value="deny">&#25298;&#32477;</button></form></li>`).join("");
    const copy = (label, value) => `<button type="button" class="copy" data-copy="${escapeHtml(value)}">${label}</button>`;
    const connected = this.profiles.size > 0;
    const install = `<div class="step"><span class="number">1</span><div><h2>添加浏览器扩展</h2><p>打开扩展管理页，启用开发者模式，选择「加载解压的扩展」。</p><div class="actions">${copy("复制 Edge 管理页地址", "edge://extensions")}${copy("复制 Chrome 管理页地址", "chrome://extensions")}</div><div class="path"><code>${escapeHtml(this.extensionPath)}</code>${copy("复制扩展目录路径", this.extensionPath)}</div><p class="hint">将目录路径粘贴到文件选择框；macOS 可按 ⇧⌘G。已安装可直接进行下一步。</p></div></div>`;
    const body = `<main><header><div class="mark">↗</div><div><p class="eyebrow">DSH / BROWSER</p><h1>连接你的浏览器</h1></div><span class="badge ${connected ? "online" : ""}">${connected ? "已连接" : pending.length ? "待确认" : "等待连接"}</span></header>
      <p class="intro">让聊天接着你的网页工作。保留登录状态，在对话中用 @ 选择页面。</p>
      ${connected ? `<section class="success"><h2>连接已就绪</h2><p>回到 DSH，在输入框键入 <kbd>@</kbd>，选择需要使用的标签页。</p><p class="hint">已连接 ${this.profiles.size} 个浏览器配置。需要标注页面时，打开扩展并点击「批注当前页面」。</p></section><details><summary>连接另一个浏览器</summary>${install}</details>` : `<section class="card">${pending.length ? `<details><summary>扩展已发来请求 · 查看安装步骤</summary>${install}</details>` : install}</section>`}
      ${!connected || requests ? `<section class="card step"><span class="number">2</span><div><h2>核对验证码，确认连接</h2><p>与扩展弹窗中的 4 位验证码一致后，点击允许。</p>${requests ? `<ul class="requests">${requests}</ul>` : `<div class="waiting"><span class="dot"></span>等待扩展发来请求…</div><p class="hint">安装后会自动出现，无需手动输入验证码。</p>`}</div></section>` : ""}
      <details class="help"><summary>连接帮助与本地 HTML</summary><p>浏览器限制网页直接打开扩展管理页，请复制地址后粘贴到地址栏。</p><p>如果扩展显示 OFF，请打开扩展弹窗，检查连接开关，并在「连接设置」将端口设为 <code>${this.port}</code>。</p><p>本地 HTML：在扩展详情中开启「允许访问文件网址」，再用 @ 选择已打开的文件标签页。</p><p>扩展只连接本机，不读取 Cookie；只有在对话中引用的页面才允许操作。</p></details>
      <footer><span>DSH DoYourWeb · 本机连接</span><a href="/setup">刷新状态</a></footer></main>`;
    const script = `
      for (const button of document.querySelectorAll(".copy")) button.addEventListener("click", async () => {
        const value = button.dataset.copy;
        try { await navigator.clipboard.writeText(value); } catch {
          const field = document.createElement("textarea");
          field.value = value;
          document.body.append(field);
          field.select();
          document.execCommand("copy");
          field.remove();
        }
        const label = button.textContent;
        button.textContent = "\\u5df2\\u590d\\u5236";
        setTimeout(() => { button.textContent = label; }, 1500);
      });`;
    // Poll only while nothing is pending: a reload would fight the approve buttons.
    const refresh = pending.length || connected ? "" : `<meta http-equiv="refresh" content="3">`;
    return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${refresh}<title>DSH DoYourWeb</title><style>
      *{box-sizing:border-box}body{margin:0;padding:48px 20px;font:14px/1.7 system-ui,"Microsoft YaHei",sans-serif;color:#253b38;background:#f2f5f3}main{max-width:780px;margin:auto}header{display:flex;align-items:center;gap:16px}.mark{width:48px;height:48px;display:grid;place-items:center;border-radius:14px;background:#1a6955;color:white;font-size:29px}.eyebrow{font-size:11px;letter-spacing:2px;color:#607d74;margin:0}h1{font-size:27px;letter-spacing:-.7px;margin:0}h2{font-size:17px;margin:0 0 6px}p{margin:6px 0 12px}.intro{margin:22px 0 28px;color:#596e68}.badge{margin-left:auto;white-space:nowrap;border:1px solid #d4ded9;padding:4px 11px;border-radius:20px;font-size:12px;color:#687a73}.online{background:#e0efe6;color:#176345;border-color:#c2ddcf}.card,.success{padding:24px;margin:16px 0;background:white;border:1px solid #dce5df;border-radius:16px;box-shadow:0 3px 12px #183c2605}.success{background:#e8f3ed;border-color:#bdd8c9}.step{display:flex;gap:16px}.step>div{min-width:0;flex:1}.number{flex-shrink:0;width:27px;height:27px;background:#eaf1ed;color:#36715c;border-radius:8px;text-align:center;font-weight:600}.actions{display:flex;flex-wrap:wrap;gap:6px;margin:14px 0}.path{display:flex;align-items:center;gap:8px;padding:10px 12px;background:#f5f7f5;border:1px solid #e5eae6;border-radius:9px}.path code{flex:1;min-width:0;overflow-wrap:anywhere;font:12px/1.5 ui-monospace,monospace}button{border:1px solid #d3ded6;background:white;color:#295b49;padding:8px 12px;border-radius:8px;font:inherit;font-size:12px;cursor:pointer;white-space:nowrap}button:hover{background:#edf4ef;border-color:#9fbcaa}button:focus-visible,a:focus-visible,summary:focus-visible{outline:3px solid #78b6a0;outline-offset:3px}.hint{color:#697b73;font-size:12px;margin-top:10px}ul{padding:0;list-style:none}.requests li{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;padding:14px 16px;background:#f5f8f5;border-radius:10px;margin:10px 0}.requests strong{font:600 20px ui-monospace,monospace;letter-spacing:2px}form{display:flex;gap:8px}button[value=allow]{background:#1b7156;color:white;border-color:#1b7156}button[value=deny]{color:#6a756d}.waiting{display:flex;align-items:center;gap:8px;padding:12px;background:#f6f8f6;border-radius:8px;color:#697b73}.dot{width:7px;height:7px;background:#9caf9d;border-radius:50%}details{color:#5e756a}details .step{margin-top:18px}summary{cursor:pointer}.help{padding:14px 4px}.help p{font-size:13px;margin:12px 0}footer{display:flex;justify-content:space-between;border-top:1px solid #dbe3dd;margin-top:22px;padding-top:16px;font-size:12px;color:#7c8c82}a{color:#356f57}kbd{border:1px solid #b8d0c3;border-radius:5px;padding:1px 6px;background:white}@media(max-width:520px){body{padding:24px 14px}h1{font-size:22px}.mark{display:none}.card,.success{padding:18px}.path{flex-direction:column;align-items:stretch}.step{gap:10px}.badge{font-size:11px}footer{gap:12px}}
      </style><body>${body}<script nonce="${nonce}">${script}</script></body></html>`;
  }

  handlePairPost(request, response) {
    // Same-origin form post plus the per-start key: a page on another origin can
    // neither read the key nor post here with this content type.
    const sameOrigin = !request.headers["sec-fetch-site"] || request.headers["sec-fetch-site"] === "same-origin";
    if (!sameOrigin) { response.writeHead(403).end(); return; }
    let body = "";
    request.on("data", chunk => { body += chunk; if (body.length > 4096) request.destroy(); });
    request.on("end", () => {
      const fields = new URLSearchParams(body);
      if (!sameSecret(fields.get("key"), this.setupKey)) { response.writeHead(403).end(); return; }
      const id = fields.get("id") ?? "";
      if (fields.get("action") === "allow") this.approvePairing(id);
      else this.pairings.take(id)?.socket.close(1000, "Pairing denied");
      response.writeHead(303, { Location: "/setup", "Cache-Control": "no-store" }).end();
    });
  }

  acceptExtension(ws) {
    let profile;
    ws.on("error", () => {});
    ws.on("message", raw => {
      try {
        const data = JSON.parse(raw.toString());
        if (data.method === "dsh.inventory") {
          const info = data.params;
          if (!/^[a-z0-9-]{1,80}$/i.test(info.profile) || !Array.isArray(info.tabs)
            || (info.browserSession !== undefined && !/^[a-z0-9-]{1,80}$/i.test(info.browserSession))) {
            throw new Error("Invalid inventory");
          }
          if (profile && (info.profile !== profile.sourceId || info.browserSession !== profile.sessionId)) {
            throw new Error("Profile identity changed");
          }
          if (!profile) {
            // A persisted profile does not identify a browser lifetime: Chrome can
            // reuse tab IDs after restart. Legacy clients get a connection-only ID.
            const id = info.browserSession ?? randomUUID();
            if (this.profiles.has(id) && this.profiles.get(id).sourceId !== info.profile) {
              throw new Error("Browser session identity collision");
            }
            for (const old of this.profiles.values()) {
              if (old.sourceId === info.profile) {
                this.profiles.delete(old.id);
                old.ws.close(1000, "Reconnected");
              }
            }
            profile = { id, sourceId: info.profile, sessionId: info.browserSession,
              ws, tabs: new Map(), browser: info.browser === "Edge" ? "Edge" : "Chrome" };
            this.profiles.set(profile.id, profile);
          }
          profile.tabs = new Map(info.tabs.filter(tab => Number.isSafeInteger(tab.id) && !tab.incognito && canControl(tab.url))
            .map(tab => [tab.id, { ...tab, ref: tabRef(profile.id, tab.id), browser: profile.browser,
              favicon: typeof tab.favicon === "string" && tab.favicon.length <= 12000
                && /^data:image\/png;base64,[a-zA-Z0-9+/=]+$/.test(tab.favicon) ? tab.favicon : undefined,
            }]));
          for (const relay of [...this.relays.values()]) {
            if (relay.profile === profile && !profile.tabs.has(relay.tabId)) void this.dropRelay(relay);
          }
        } else if (profile && data.method === "dsh.annotation.start") {
          const selected = profile.tabs.get(data.params?.tabId);
          if (selected) this.emit("annotation", selected.ref);
        } else if (data.method === "dsh.diagnostic" && profile) {
          const pending = this.pending.get(data.params?.id);
          if (pending?.ws === ws && ["extension_receive", "api_settle", "extension_response"].includes(data.params.phase)) {
            this.diagnostics.record({ id: data.params.id, method: pending.method, phase: data.params.phase,
              elapsedMs: Date.now() - pending.started, extensionVersion: data.params.version });
          }
        } else if (data.id && this.pending.has(data.id)) {
          const pending = this.pending.get(data.id);
          if (pending.ws !== ws) throw new Error("Wrong connection for response");
          this.pending.delete(data.id); clearTimeout(pending.timer);
          this.diagnostics.record({ id: data.id, method: pending.method, phase: "host_response",
            elapsedMs: Date.now() - pending.started, error: data.error });
          data.error ? pending.reject(new Error(data.error)) : pending.resolve(data.result);
        } else if (profile && data.method === "chrome.debugger.onEvent") {
          const [source, method, params] = data.params;
          this.emit("debuggerEvent", profile, source, method, params);
          for (const relay of this.relays.values()) {
            if (relay.profile === profile && relay.tabId === source.tabId) relay.model.onDebuggerEvent(source, method, params);
          }
        } else if (profile && data.method === "chrome.debugger.onDetach") {
          for (const relay of [...this.relays.values()]) {
            if (relay.profile === profile && relay.tabId === data.params[0].tabId) this.dropRelay(relay);
          }
        } else if (data.method === "dsh.ping") ws.send(JSON.stringify({ method: "dsh.pong" }));
      } catch { ws.close(1003, "Invalid bridge message"); }
    });
    ws.on("close", () => {
      if (profile && this.profiles.get(profile.id) === profile) this.profiles.delete(profile.id);
      for (const [id, pending] of this.pending) {
        if (pending.ws === ws) {
          this.diagnostics.record({ id, method: pending.method, phase: "disconnect", elapsedMs: Date.now() - pending.started, error: "disconnected" });
          this.pending.delete(id); clearTimeout(pending.timer); pending.reject(new Error("Browser extension disconnected"));
        }
      }
      for (const relay of [...this.relays.values()]) if (relay.profile === profile) this.dropRelay(relay);
    });
  }

  request(profile, method, params) {
    if (profile.ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error("Browser extension disconnected"));
    const id = ++this.sequence;
    const started = Date.now();
    const command = method === "chrome.debugger.sendCommand" ? params[1] : method;
    this.diagnostics.record({ id, method: command, phase: "host_send" });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.diagnostics.record({ id, method: command, phase: "timeout", elapsedMs: Date.now() - started, error: "timeout" });
        reject(new Error(`Browser command timed out: ${command} (request ${id})`));
      }, 15000);
      this.pending.set(id, { resolve, reject, timer, ws: profile.ws, method: command, started });
      profile.ws.send(JSON.stringify({ id, method, params, diagnostics: this.diagnostics.enabled }));
    });
  }

  list(query = "") {
    const needle = query.toLowerCase().trim();
    return [...this.profiles.values()].flatMap(profile => [...profile.tabs.values()])
      .filter(tab => !needle || `${tab.title} ${tab.url} ${tab.browser}`.toLowerCase().includes(needle))
      .sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0)).slice(0, 50);
  }

  resolve(ref) {
    const { profile: id, tabId } = parseRef(ref);
    const profile = this.profiles.get(id);
    if (!profile) throw new Error("Browser extension is offline or its browser session ended. Open /browser to connect, then select the tab with @ again.");
    const tab = profile.tabs.get(tabId);
    if (!tab) throw new Error("Referenced browser tab is closed or unsupported. Select a tab with @ again.");
    return { profile, tab, tabId };
  }

  async page(ref) {
    await this.detachments.get(ref);
    const { profile, tab, tabId } = this.resolve(ref);
    const existing = [...this.relays.values()].find(relay => relay.profile === profile && relay.tabId === tabId);
    if (existing) { clearTimeout(existing.idleTimer); return existing.ready; }
    const pathname = `/cdp/${randomUUID()}`;
    const model = new BrowserModel((method, params) => this.request(profile, method, params));
    model.onTabCreated(tab);
    const relay = { pathname, ref, profile, tabId, model };
    this.relays.set(pathname, relay);
    const connectionId = `connect-${++this.sequence}`, started = Date.now();
    this.diagnostics.record({ id: connectionId, method: "connectOverCDP", phase: "connect_start" });
    relay.ready = chromium.connectOverCDP(`ws://127.0.0.1:${this.port}${pathname}`, {
      // The paired extension and this host share the local filesystem. Without
      // isLocal, Playwright converts upload paths into base64 payloads.
      isLocal: true,
      headers: { Authorization: `Bearer ${this.settings.token}` }, timeout: 15000,
    }).then(async browser => {
      relay.browser = browser;
      browser.on("disconnected", () => this.dropRelay(relay));
      const page = browser.contexts()[0]?.pages()[0];
      if (!page) throw new Error("Browser did not expose the referenced tab");
      page.setDefaultTimeout(8000);
      page.setDefaultNavigationTimeout(12000);
      await this.decoratePage?.(ref, page);
      this.diagnostics.record({ id: connectionId, method: "connectOverCDP", phase: "connect_ready", elapsedMs: Date.now() - started });
      return page;
    }).catch(error => {
      this.diagnostics.record({ id: connectionId, method: "connectOverCDP", phase: "connect_failed", elapsedMs: Date.now() - started, error });
      this.dropRelay(relay); throw error;
    });
    return relay.ready;
  }

  cdp(ref) {
    const { profile, tabId } = this.resolve(ref);
    const session = new EventEmitter();
    const receive = (owner, source, method, params) => {
      if (owner === profile && source.tabId === tabId && !source.sessionId) session.emit(method, params);
    };
    this.on("debuggerEvent", receive);
    session.send = (method, params) => this.request(profile, "chrome.debugger.sendCommand", [{ tabId }, method, params]);
    session.detach = async () => { this.off("debuggerEvent", receive); };
    return session;
  }

  acceptCDP(relay, ws) {
    relay.ws = ws;
    ws.on("error", () => {});
    const send = message => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message)); };
    relay.model.connectOverCDP(send);
    ws.on("message", async raw => {
      let message;
      try { message = JSON.parse(raw.toString()); }
      catch { return this.dropRelay(relay); }
      // A CDP command without a numeric id can never be answered; dropping the
      // relay surfaces one protocol violation instead of hanging the caller.
      if (!Number.isSafeInteger(message?.id)) return this.dropRelay(relay);
      try {
        const result = await relay.model.command(message.method, message.params, message.sessionId);
        send({ id: message.id, sessionId: message.sessionId, result });
      } catch (error) { send({ id: message.id, sessionId: message.sessionId, error: { message: error.message } }); }
    });
    ws.on("close", () => this.dropRelay(relay));
  }

  dropRelay(relay) {
    if (!this.relays.delete(relay.pathname)) return this.detachments.get(relay.ref);
    clearTimeout(relay.idleTimer);
    this.emit("release", relay.ref);
    const cleanup = (async () => {
      try { await this.beforeRelease?.(relay.ref); } catch { /* Detach must finish even if a page has already gone away. */ }
      relay.ws?.close();
      const closing = relay.browser?.close().catch(() => {});
      const detached = relay.profile.ws.readyState === WebSocket.OPEN
        ? this.request(relay.profile, "chrome.debugger.detach", [{ tabId: relay.tabId }]).catch(() => {}) : undefined;
      await Promise.all([closing, detached]);
    })().finally(() => {
      if (this.detachments.get(relay.ref) === cleanup) this.detachments.delete(relay.ref);
    });
    this.detachments.set(relay.ref, cleanup);
    return cleanup;
  }

  release(ref) {
    const relay = [...this.relays.values()].find(relay => relay.ref === ref);
    if (!relay) return;
    clearTimeout(relay.idleTimer);
    relay.idleTimer = setTimeout(() => void this.dropRelay(relay), this.idleTimeoutMs);
    relay.idleTimer.unref();
  }

  async focus(ref) {
    const { profile, tabId } = this.resolve(ref);
    await this.request(profile, "dsh.focus", [tabId]);
  }

  async close() {
    for (const relay of [...this.relays.values()]) this.dropRelay(relay);
    await Promise.all(this.detachments.values());
    for (const client of this.ws?.clients || []) client.close();
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error("Bridge stopped")); }
    this.pending.clear();
    this.ws?.close();
    if (this.server?.listening) await new Promise(resolve => {
      this.server.close(resolve);
      // Management-page fetch connections must not keep plugin unload waiting.
      this.server.closeAllConnections();
    });
  }
}
