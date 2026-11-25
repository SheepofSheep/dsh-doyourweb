import { createElement as h, useEffect, useState } from "react";
import { IconGlobeOutlineRegular } from "@deepseek-ai/dsh-client-ui-primitives";
import { formatMention } from "./protocol.js";
import { contextDisplay, contextRule, insertDraftReference } from "./context-display.js";

const id = "doyourweb-browser";
export const browserStyles = `
.dyw-panel,.dyw-context{--dyw-ink:var(--dsw-alias-label-primary,#242424);--dyw-muted:var(--dsw-alias-label-secondary,#666);--dyw-ground:var(--dsw-alias-bg-base,#fff);--dyw-hover:var(--dsw-alias-interactive-bg-hover,#f3f3f3);--dyw-line:var(--dsw-alias-border-l3,#e5e5e5);--dyw-focus:var(--dsw-focus-ring-color,#0066cc);--dyw-control-radius:8px;--dyw-card-radius:12px;font-family:var(--ds-font-family,"Segoe UI"),"Microsoft YaHei UI","Microsoft YaHei","Noto Sans CJK SC",sans-serif;color:var(--dyw-ink);font-variant-numeric:tabular-nums;font-size:14px;line-height:1.5}
.dyw-panel{box-sizing:border-box;height:100%;min-width:0;overflow:auto;scrollbar-width:thin;padding:12px 16px;background:var(--dyw-ground);container-type:inline-size}
.dyw-panel *,.dyw-context *{box-sizing:border-box}.dyw-panel ::selection,.dyw-context ::selection{background:var(--dyw-line);color:var(--dyw-ink)}.dyw-panel h2{font-size:18px;margin:0;font-weight:600}.dyw-panel header,.dyw-heading,.dyw-actions,.dyw-header-actions,.dyw-tabs{display:flex;align-items:center;gap:8px}.dyw-panel header{justify-content:space-between;flex-wrap:wrap;margin-bottom:8px}.dyw-header-actions{gap:4px}
.dyw-panel button,.dyw-panel input{font:inherit;color:inherit;border:1px solid var(--dyw-line);border-radius:var(--dyw-control-radius);background:transparent;padding:5px 8px;min-height:32px}.dyw-panel button{cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:6px}.dyw-panel button:hover{background:var(--dyw-hover)}.dyw-panel button:disabled{cursor:default;opacity:.5}.dyw-panel :is(button,input,summary):focus-visible,.dyw-context summary:focus-visible{outline:2px solid var(--dyw-focus);outline-offset:1px}.dyw-panel .dyw-icon-button{width:32px;padding:0;border-color:transparent}.dyw-panel .dyw-settings{font-size:12px}
.dyw-tabs{margin-bottom:8px;border-bottom:1px solid var(--dyw-line);gap:16px}.dyw-panel .dyw-tabs button{border:0;border-radius:0;position:relative;padding:0 0 4px;color:var(--dyw-muted);min-height:32px;background:none}.dyw-panel .dyw-tabs button[aria-selected=true]{color:var(--dyw-ink);font-weight:600}.dyw-tabs button[aria-selected=true]:after{content:"";position:absolute;bottom:-1px;height:2px;background:currentColor;left:0;right:0}
.dyw-search{position:relative;display:flex;align-items:center;margin-bottom:8px}.dyw-search>svg{position:absolute;left:10px;color:var(--dyw-muted);pointer-events:none}.dyw-panel input[type=search]{width:100%;padding-left:32px;min-height:34px;background:var(--dyw-hover);border-color:transparent;caret-color:var(--dyw-ink)}.dyw-panel input::placeholder{color:var(--dyw-muted);opacity:1}.dyw-panel input[type=checkbox]{min-height:0;accent-color:var(--dyw-ink)}
.dyw-muted{color:var(--dyw-muted);font-size:12px}.dyw-status{margin:0 0 8px;overflow-wrap:anywhere}.dyw-status:empty{display:block;margin:0}.dyw-count{margin:0 0 4px}.dyw-list{list-style:none;padding:0;margin:0}.dyw-list li+li{border-top:1px solid var(--dyw-line)}.dyw-panel .dyw-object{display:flex;align-items:center;gap:8px;width:100%;min-height:48px;text-align:left;border:0;padding:4px 6px;justify-content:flex-start}.dyw-object>span{min-width:0;flex:1;display:block}.dyw-object strong,.dyw-object small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dyw-object strong{font-weight:500}.dyw-object img,.dyw-object svg{flex:none}.dyw-object small,.dyw-object .dyw-add{color:var(--dyw-muted);font-size:12px}.dyw-panel [aria-busy=true] .dyw-object{cursor:progress}
.dyw-actions{flex-wrap:wrap;margin:8px 0}.dyw-empty{margin-top:8px;padding:12px;background:var(--dyw-hover);border-radius:var(--dyw-card-radius)}.dyw-empty strong{display:block;font-weight:500}.dyw-empty p{font-size:12px;color:var(--dyw-muted);margin:4px 0 0}.dyw-empty button{margin-top:8px}.dyw-panel pre,.dyw-context pre{white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.6 var(--ds-font-family-code,ui-monospace),monospace;max-height:320px;overflow:auto;margin:8px 0 0;scrollbar-width:thin}
.dyw-context{display:inline;white-space:normal;max-width:100%}.dyw-context>summary{display:inline-flex;align-items:center;gap:8px;vertical-align:middle;max-width:100%;cursor:pointer;list-style:none;border:1px solid var(--dyw-line);border-radius:var(--dyw-card-radius);padding:4px 8px;margin:2px 4px 2px 0;min-height:32px;background:var(--dyw-ground)}.dyw-context>summary:hover,.dyw-context[open]>summary{background:var(--dyw-hover)}.dyw-context>summary::-webkit-details-marker{display:none}.dyw-context[open]{display:block}.dyw-context>summary span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}.dyw-context>summary svg{flex:none}.dyw-context .dyw-chevron{transition:transform .12s ease-out}.dyw-context[open] .dyw-chevron{transform:rotate(90deg)}
.dyw-context-body{margin:4px 0 8px;padding:8px 12px;border:1px solid var(--dyw-line);border-radius:var(--dyw-card-radius);background:var(--dyw-ground);overflow-wrap:anywhere}.dyw-context-body p{margin:0;white-space:pre-wrap}.dyw-context-body .dyw-muted{display:block;margin-bottom:4px}.dyw-context-body>details{margin-top:8px}.dyw-context-body>details summary{cursor:pointer;color:var(--dyw-muted);font-size:12px}.dyw-context-body>pre{margin:0}
.dyw-panel label{display:flex;align-items:center;gap:7px}.dyw-event{padding:8px 0;border-bottom:1px solid var(--dyw-line)}.dyw-event summary{cursor:pointer;overflow-wrap:anywhere}.dyw-event small{display:block;font-size:12px;color:var(--dyw-muted)}.dyw-preview-note{margin:0 0 8px}.dyw-log-header{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}.dyw-log-header>span{white-space:nowrap}.dyw-log-menu>summary{cursor:pointer;font-size:12px;color:var(--dyw-muted)}@media(prefers-reduced-motion:reduce){.dyw-context .dyw-chevron{transition:none}}@container(max-width:240px){.dyw-panel h2{font-size:16px}.dyw-header-actions,.dyw-tabs{gap:4px}.dyw-panel .dyw-settings{padding-inline:5px}}
`;

export function BrowserGlyph({ kind = "app", size = 16, ...props }) {
  const paths = { app: "M4 4h16v13H4zM8 21h8m-4-4v4", search: "m16 16 4 4M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0", refresh: "M20 7v5h-5M4 17v-5h5M5 8a8 8 0 0 1 13-3l2 3M4 16l2 3a8 8 0 0 0 13-3", add: "M12 5v14M5 12h14", chevron: "m9 5 7 7-7 7", annotation: "m4 16-1 5 5-1L20 8l-4-4zM13 7l4 4", log: "M5 3h14v18H5zM9 8h6m-6 4h6m-6 4h4" };
  return h("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true, ...props }, h("path", { d: paths[kind] || paths.app }));
}

export function ObjectIcon({ src, app = false, size = 18 }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  return src && !failed ? h("img", { src, width: size, height: size, alt: "", style: { display: "block", objectFit: "contain" }, onError: () => setFailed(true) })
    : app ? h(BrowserGlyph, { size }) : h(IconGlobeOutlineRegular, { size });
}

export function CompactContext({ node, raw }) {
  const text = raw ?? node.data.text;
  const { kind, label } = node.data;
  const icon = { doyourweb_annotation: "annotation", doyourweb_context: "app", doyourweb_log: "log" }[kind];
  return h("details", { className: "dyw-context" }, h("summary", { title: label },
    icon ? h(BrowserGlyph, { kind: icon, size: 14 }) : h(IconGlobeOutlineRegular, { size: 14 }),
    h("span", null, label), h(BrowserGlyph, { kind: "chevron", size: 12, className: "dyw-chevron" })),
    h(ContextContent, { text }));
}

function ContextContent({ text }) {
  const { body, source, code, details } = contextDisplay(text);
  return h("div", { className: "dyw-context-body" },
    source && h("small", { className: "dyw-muted" }, source),
    h(code ? "pre" : "p", null, body),
    details && h("details", null, h("summary", null, "元素详情"), h("pre", null, details)),
    body !== text && h("details", null, h("summary", null, `原始引用 · ${text.length.toLocaleString()} 字符`), h("pre", null, text)));
}

export function BrowserPanel({ service, conversation, sessionId, watchTabs }) {
  const [view, setView] = useState("tabs"), [query, setQuery] = useState(""), [items, setItems] = useState([]);
  const [logs, setLogs] = useState(null), [busy, setBusy] = useState(true), [notice, setNotice] = useState("");
  const [failed, setFailed] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [search, setSearch] = useState("");
  const [authorizationSession, setAuthorizationSession] = useState();
  useEffect(() => {
    const timer = setTimeout(() => setSearch(query), 200);
    return () => clearTimeout(timer);
  }, [query]);
  useEffect(() => {
    if (view !== "tabs" || !watchTabs) return;
    const controller = new AbortController();
    watchTabs(() => setRefresh(value => value + 1), controller.signal);
    return () => controller.abort();
  }, [view, watchTabs]);
  useEffect(() => {
    const controller = new AbortController();
    setBusy(true); setNotice(""); setFailed(false);
    const load = async () => {
      const result = await service()[view === "logs" ? "diagnostics" : view === "tabs" ? "list" : "apps"](view === "logs" ? {} : { query: search, ...(view === "tabs" && sessionId ? { sessionId } : {}) }, controller.signal);
      if (controller.signal.aborted) return;
      if (!result.ok) throw new Error("无法载入，请重试或检查浏览器连接。");
      if (view === "logs") setLogs(result.value);
      else {
        setItems(result.value[view === "tabs" ? "tabs" : "apps"]);
        if (view === "tabs") setAuthorizationSession(sessionId);
        if (result.value.error) { setFailed(true); setNotice("应用列表暂时不可用，请重试。"); }
        if (result.value.connected === false) setNotice("浏览器尚未连接，请打开连接设置。");
      }
    };
    load().catch(() => { if (!controller.signal.aborted) { setFailed(true); setNotice("无法载入，请重试或检查连接。"); } })
      .finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [view, search, refresh, sessionId, service]);
  const tabs = [["tabs", "网页"], ["apps", "应用"], ["logs", "诊断日志"]];
  const changeView = key => { if (key === view) return; setItems([]); setLogs(null); setView(key); setQuery(""); setSearch(""); };
  const pick = item => {
    const label = view === "tabs" ? item.title || item.url : item.comment || [item.displayName || item.product || item.name, item.title].filter(Boolean).join(" · ");
    const ref = view === "tabs" ? formatMention(item) : `@[${label.replace(/[\[\]\\\r\n]/g, " ").slice(0, 128)}](${item.ref})`;
    setNotice(insertDraftReference(conversation, sessionId, { source: view === "tabs" ? "browser-tabs" : "desktop-apps", ref, label,
      appearance: "file", clipboardText: ref }) ? "已加入当前会话草稿" : "当前草稿正在提交，请稍后再试。");
  };
  const updateLogs = async request => {
    try {
      const result = await service().diagnostics(request);
      if (result.ok) setLogs(result.value); else setNotice("日志操作失败，请重试。");
    } catch { setNotice("日志操作失败，请重试。"); }
  };
  const exportLogs = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(logs, null, 2)], { type: "application/json" }));
    const link = document.createElement("a"); link.href = url; link.download = `doyourweb-diagnostics-${Date.now()}.json`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return h("section", { className: "dyw-panel", "aria-label": "浏览器" },
    h("header", null, h("div", { className: "dyw-heading" }, h(IconGlobeOutlineRegular, { size: 20 }), h("h2", null, "浏览器")),
      h("div", { className: "dyw-header-actions" },
        view !== "logs" && h("button", { className: "dyw-settings", onClick: () => void (async () => {
          const result = await service()[view === "tabs" ? "setup" : "manage"]({});
          if (result.ok) window.open(result.value.url, "_blank", "noopener");
          else setNotice("无法打开设置，请重试。");
        })().catch(() => setNotice("无法打开设置，请重试。")) }, view === "tabs" ? "连接设置" : "应用管理"),
        h("button", { className: "dyw-icon-button", onClick: () => setRefresh(value => value + 1), disabled: busy, title: "刷新", "aria-label": "刷新" }, h(BrowserGlyph, { kind: "refresh", size: 16 })))),
    h("div", { className: "dyw-tabs", role: "tablist", "aria-label": "浏览器内容" }, ...tabs.map(([key, text], index) =>
      h("button", { key, id: `${id}-${key}`, role: "tab", "aria-selected": view === key, "aria-controls": `${id}-content`, tabIndex: view === key ? 0 : -1,
        onKeyDown: event => {
          const next = event.key === "ArrowRight" ? (index + 1) % tabs.length : event.key === "ArrowLeft" ? (index + tabs.length - 1) % tabs.length : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : -1;
          if (next < 0) return; event.preventDefault(); changeView(tabs[next][0]); event.currentTarget.parentElement.children[next].focus();
        }, onClick: () => changeView(key) }, text))),
    view !== "logs" && h("div", { className: "dyw-search" }, h(BrowserGlyph, { kind: "search", size: 15 }),
      h("input", { type: "search", placeholder: view === "tabs" ? "搜索网页标题或地址" : "搜索应用或窗口", "aria-label": "搜索", value: query, onChange: event => setQuery(event.target.value) })),
    h("p", { role: "status", className: "dyw-muted dyw-status" }, busy ? "正在载入…" : notice || (!sessionId && view !== "logs" ? "打开聊天会话后可加入草稿。" : "")),
    view === "tabs" && h("p", { className: "dyw-muted" }, "授权标签仅对应当前会话，发送引用后可点刷新更新。加入草稿不会新增授权；发送含 @ 引用的消息会授权当前会话使用该页。"),
    h("div", { id: `${id}-content`, role: "tabpanel", "aria-labelledby": `${id}-${view}`, "aria-busy": busy },
    view === "logs" ? logs && h("div", null,
      h("div", { className: "dyw-log-header" },
        h("label", null, h("input", { type: "checkbox", checked: logs.enabled, onChange: event => void updateLogs({ enabled: event.target.checked }) }), "记录诊断"),
        h("span", { className: "dyw-muted", title: "仅保存在本机内存，不自动加入聊天" }, `${logs.events.length} / ${logs.capacity} 条 · 主机 ${logs.version}`)),
      logs.extensions?.length > 0 && h("p", { className: "dyw-muted" }, logs.extensions.map(extension => `${extension.browser} 扩展 ${extension.version || "未知"}`).join(" · ")),
      ...((logs.extensions || []).filter(extension => extension.compatibilityWarning).map((extension, index) => h("p", { key: index, role: "status", className: "dyw-muted" }, `${extension.browser}：${extension.compatibilityWarning}`))),
      h("div", { className: "dyw-actions" },
        h("button", { disabled: !sessionId || !logs.events.length, onClick: () => {
          const text = `<doyourweb_log>\n${JSON.stringify(logs, null, 2)}\n</doyourweb_log>`;
          setNotice(insertDraftReference(conversation, sessionId, { source: "doyourweb-context", ref: text, label: "诊断日志", appearance: "file", clipboardText: text }) ? "日志已加入当前草稿" : "当前草稿正在提交，请稍后再试。");
        } }, "引用到草稿")),
      h("details", { className: "dyw-log-menu" }, h("summary", null, "日志管理"),
        h("div", { className: "dyw-actions" }, h("button", { onClick: exportLogs }, "导出"), h("button", { onClick: () => void updateLogs({ clear: true }), disabled: !logs.events.length }, "清空"))),
      !logs.events.length && h("div", { className: "dyw-empty" }, h("strong", null, "暂无诊断记录"), h("p", null, logs.enabled ? "使用浏览器功能后，记录将显示在这里。" : "开启记录后，再使用浏览器功能。")),
      ...logs.events.slice().reverse().map((event, index) => h("details", { className: "dyw-event", key: index },
        h("summary", null, `${event.method} · ${event.code || event.phase}`, h("small", null, `${event.time.slice(11, 19)} · ${event.elapsedMs} ms · ${event.correlationId}`)), h("pre", null, JSON.stringify(event, null, 2)))))
      : h("div", null, !busy && !!items.length && h("p", { className: "dyw-count dyw-muted" }, `${items.length} 个${view === "tabs" ? "网页" : "应用"}`),
        h("ul", { className: "dyw-list" }, ...items.map(item => {
          const title = item.comment || (view === "tabs" ? item.title || item.url : item.displayName || item.product || item.name);
          const authorized = sessionId && authorizationSession === sessionId ? item.authorized : undefined;
          const subtitle = view === "tabs" ? `${new URL(item.url).protocol === "file:" ? "本地 HTML" : new URL(item.url).hostname} · ${item.browser} · ${authorized === true ? "本会话已授权" : authorized === false ? "本会话未授权" : "授权状态未知"}${item.discarded || item.frozen || item.status === "unloaded" ? " · 休眠，打开后可用" : ""}` : item.title;
          return h("li", { key: item.ref }, h("button", { className: "dyw-object", title: `${title}\n${subtitle || ""}\n加入草稿`, disabled: !sessionId, onClick: () => pick(item) },
            h(ObjectIcon, { src: view === "tabs" ? item.favicon : item.icon, app: view === "apps" }), h("span", null, h("strong", null, title), h("small", null, subtitle)), h(BrowserGlyph, { kind: "add", size: 14, className: "dyw-add" })));
        })),
        !busy && !items.length && h("div", { className: "dyw-empty" }, h("strong", null, failed ? "列表暂时不可用" : query ? "没有找到匹配结果" : view === "tabs" ? "暂无可引用网页" : "暂无可引用应用"),
          h("p", null, failed ? "检查连接后，刷新重试。" : query ? "试试其他关键词，或清除搜索条件。" : view === "tabs" ? "在已连接的浏览器中打开一个网页。" : "打开一个应用窗口后刷新。"),
          (failed || query) && h("button", { onClick: () => query ? setQuery("") : setRefresh(value => value + 1) }, query ? "清除搜索" : "重新载入"))),
      failed && view === "logs" && h("button", { onClick: () => setRefresh(value => value + 1) }, "重新载入")));
}

export function registerBrowserPanel(ctx, watchTabs) {
  ctx.effect(() => ctx.inputTriggers.registerSource({ trigger: "@", name: "doyourweb-context", candidates: async () => [],
    codec: { clipboardText: ref => ref, serialize: async ref => ref },
    openReference(session, { ref }) {
      const open = ctx.get("doyourwebContextPreview");
      if (!open) return false;
      open(session.sessionId, ref); return true;
    } }));
  ctx.inject?.(["slots", "layout", "sidebarRight", "sidebarRightTabs", "conversation", "uiConversation", "sessions"], scope => {
    const style = document.createElement("style"); style.textContent = browserStyles; document.head.appendChild(style);
    scope.effect(() => () => style.remove());
    const service = () => ctx.get("remote.browserTabs");
    const previews = new Map(), listeners = new Set();
    scope.provide("doyourwebContextPreview", (sessionId, text) => {
      previews.set(sessionId, text);
      for (const listener of listeners) listener();
      scope.sidebarRight.openTab(`${id}-context`);
    });
    function ContextPreview({ sessionId }) {
      const [, redraw] = useState(0);
      useEffect(() => { const listener = () => redraw(value => value + 1); listeners.add(listener); return () => listeners.delete(listener); }, []);
      const text = previews.get(sessionId);
      return h("section", { className: "dyw-panel", "aria-label": "引用详情" }, h("header", null, h("h2", null, "引用详情")),
        text ? h(ContextContent, { text }) : h("p", { className: "dyw-muted dyw-preview-note" }, "点击当前会话草稿中的引用，即可查看。"));
    }
    scope.effect(() => scope.sidebarRightTabs.register({ id: `${id}-context`, kind: `${id}-context`, priority: "extension", title: () => "引用详情" }));
    scope.slots.inject("sidebar.right.pane.tab", () => scope.slots.register({ name: "sidebar.right.pane.tab", key: `${id}-context`,
      inject: sessionId => ({ sessionId }) }, ContextPreview));
    scope.slots.inject("sidebar.right.pane.tab.title", () => scope.slots.register({ name: "sidebar.right.pane.tab.title", key: `${id}-context` }, () => h("span", null, "引用详情")));
    scope.effect(() => scope.uiConversation.userText.register(contextRule));
    scope.slots.inject("conversation.user.text.node", () => scope.slots.register({ name: "conversation.user.text.node", key: contextRule.id }, CompactContext));
    scope.effect(() => scope.sidebarRightTabs.register({ id, kind: id, priority: "extension", title: () => "浏览器" }));
    scope.slots.inject("sidebar.right.pane.tab", () => scope.slots.register({ name: "sidebar.right.pane.tab", key: id,
      inject: sessionId => ({ sessionId, service, watchTabs, conversation: scope.get("conversation") }) }, BrowserPanel));
    scope.slots.inject("sidebar.right.pane.tab.title", () => scope.slots.register({ name: "sidebar.right.pane.tab.title", key: id }, () => h("span", null, "浏览器")));
    // A global navigation entry launches the session-owned native dock. The next frame
    // follows the Conversation's remount; its editor and right pane keep their own lifetimes.
    let frame;
    scope.effect(() => () => cancelAnimationFrame(frame));
    function LaunchBrowser() {
      const current = Object.values(scope.sessions.list.getSnapshot().byId).find(session => (session.retainedBy?.mainView ?? 0) > 0);
      useEffect(() => {
        if (!current) return;
        scope.layout.selectPanel(null);
        frame = requestAnimationFrame(() => scope.sidebarRight.openTab(id));
      }, []);
      return current ? null : h(BrowserPanel, { service, watchTabs, conversation: scope.get("conversation") });
    }
    scope.slots.inject("main", () => scope.slots.register({ name: "main", key: id }, LaunchBrowser));
    scope.slots.inject("sidebar.panellist", () => scope.slots.register({ name: "sidebar.panellist", id, order: 25, label: "浏览器" }, IconGlobeOutlineRegular));
  });
}
