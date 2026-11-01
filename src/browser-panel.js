import { createElement as h, useEffect, useState } from "react";
import { IconGlobeOutlineRegular } from "@deepseek-ai/dsh-client-ui-primitives";
import { formatMention } from "./protocol.js";
import { contextRule, insertDraftReference } from "./context-display.js";

const id = "doyourweb-browser";
export const browserStyles = `
.dyw-panel{box-sizing:border-box;height:100%;min-width:0;overflow:auto;padding:16px;color:var(--dsw-alias-label-primary,#242424);background:var(--dsw-alias-bg-base,#fff);font:14px/1.5 var(--ds-font-family,system-ui)}
.dyw-panel *{box-sizing:border-box}.dyw-panel h2{font-size:18px;margin:0;font-weight:600}.dyw-panel header,.dyw-actions,.dyw-tabs{display:flex;align-items:center;gap:8px}.dyw-panel header{justify-content:space-between;margin-bottom:16px}.dyw-tabs{margin-bottom:16px;flex-wrap:wrap}.dyw-panel button,.dyw-panel input{font:inherit;color:inherit;border:1px solid var(--dsw-alias-border-l3,#dedede);border-radius:var(--dsw-radius-sm,6px);background:transparent;padding:6px 10px;min-height:32px}.dyw-panel button{cursor:pointer}.dyw-panel button:hover,.dyw-tabs button[aria-selected=true]{background:var(--dsw-alias-interactive-bg-hover,#eee)}.dyw-panel button:disabled{cursor:default;opacity:.55}.dyw-panel button:focus-visible,.dyw-panel input:focus-visible,.dyw-context summary:focus-visible{outline:2px solid var(--dsw-focus-ring-color,#777);outline-offset:2px}.dyw-panel input[type=search]{width:100%;margin-bottom:12px}.dyw-panel input[type=checkbox]{min-height:0;accent-color:currentColor}.dyw-muted{color:var(--dsw-alias-label-secondary,#626262);font-size:12px}.dyw-list{list-style:none;padding:0;margin:0}.dyw-list li+li{margin-top:4px}.dyw-panel .dyw-object{display:flex;align-items:center;gap:10px;width:100%;text-align:left;border-color:transparent;padding:10px 8px}.dyw-object span{min-width:0;display:block}.dyw-object strong,.dyw-object small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:400}.dyw-object img,.dyw-object svg{flex:none}.dyw-object small{color:var(--dsw-alias-label-secondary,#626262);font-size:12px}.dyw-actions{flex-wrap:wrap;margin:12px 0}.dyw-panel pre,.dyw-context pre{white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.6 var(--ds-font-family-code,monospace);max-height:360px;overflow:auto;margin:10px 0 0}.dyw-context{display:inline;white-space:normal}.dyw-context summary{display:inline-flex;align-items:center;gap:6px;vertical-align:middle;max-width:100%;cursor:pointer;list-style:none;border:1px solid var(--dsw-alias-border-l3,#dedede);border-radius:6px;padding:3px 8px;margin:2px 3px;font:13px/20px var(--ds-font-family,system-ui);color:var(--dsw-alias-label-primary,#242424);background:var(--dsw-alias-bg-base,#fff)}.dyw-context summary::-webkit-details-marker{display:none}.dyw-context[open]{display:block}.dyw-context[open]>pre{padding:12px;background:var(--dsw-alias-interactive-bg-hover,#f3f3f3);border-radius:6px}.dyw-context summary span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dyw-panel label{display:flex;align-items:center;gap:6px}.dyw-event{padding:10px 0;border-bottom:1px solid var(--dsw-alias-border-l3,#dedede)}.dyw-event summary{cursor:pointer;overflow-wrap:anywhere}.dyw-event small{display:block;font-size:12px;color:var(--dsw-alias-label-secondary,#626262)}
`;

export function CompactContext({ node, raw }) {
  return h("details", { className: "dyw-context" }, h("summary", { title: node.data.label },
    h(IconGlobeOutlineRegular, { size: 14 }), h("span", null, node.data.label)), h("pre", null, raw));
}

export function BrowserPanel({ service, conversation, sessionId }) {
  const [view, setView] = useState("tabs"), [query, setQuery] = useState(""), [items, setItems] = useState([]);
  const [logs, setLogs] = useState(null), [busy, setBusy] = useState(false), [notice, setNotice] = useState("");
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setBusy(true); setNotice(""); setItems([]);
    const load = async () => {
      const result = await service()[view === "logs" ? "diagnostics" : view === "tabs" ? "list" : "apps"](view === "logs" ? {} : { query }, controller.signal);
      if (controller.signal.aborted) return;
      if (!result.ok) throw new Error("无法载入，请重试或检查浏览器连接。");
      if (view === "logs") setLogs(result.value);
      else {
        setItems(result.value[view === "tabs" ? "tabs" : "apps"]);
        if (result.value.error) setNotice("应用列表暂时不可用，请重试。");
        if (result.value.connected === false) setNotice("浏览器尚未连接，请打开连接设置。");
      }
    };
    load().catch(() => { if (!controller.signal.aborted) setNotice("无法载入，请重试或检查连接。"); })
      .finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [view, query, refresh, sessionId, service]);
  const pick = item => {
    const label = view === "tabs" ? item.title || item.url : item.comment || [item.displayName || item.product || item.name, item.title].filter(Boolean).join(" · ");
    const ref = view === "tabs" ? formatMention(item) : `@[${label.replace(/[\[\]\\\r\n]/g, " ").slice(0, 128)}](${item.ref})`;
    setNotice(insertDraftReference(conversation, sessionId, { source: view === "tabs" ? "browser-tabs" : "desktop-apps", ref, label,
      appearance: "file", clipboardText: ref }) ? "已加入当前会话草稿" : "当前草稿正在提交，请稍后再试。");
  };
  const updateLogs = async request => {
    const result = await service().diagnostics(request);
    if (result.ok) setLogs(result.value); else setNotice("日志操作失败，请重试。");
  };
  const exportLogs = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(logs, null, 2)], { type: "application/json" }));
    const link = document.createElement("a"); link.href = url; link.download = `doyourweb-diagnostics-${Date.now()}.json`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return h("section", { className: "dyw-panel", "aria-label": "浏览器" },
    h("header", null, h("h2", null, "浏览器"), h("button", { onClick: () => setRefresh(value => value + 1), disabled: busy }, "刷新")),
    h("div", { className: "dyw-tabs", role: "tablist", "aria-label": "浏览器内容" }, ...[["tabs", "网页"], ["apps", "应用"], ["logs", "打开日志"]].map(([key, text]) =>
      h("button", { key, role: "tab", "aria-selected": view === key, onClick: () => { setItems([]); setView(key); setQuery(""); } }, text))),
    view !== "logs" && h("input", { type: "search", placeholder: view === "tabs" ? "搜索已打开的网页" : "搜索应用", "aria-label": "搜索", value: query, onChange: event => setQuery(event.target.value) }),
    h("p", { role: "status", className: "dyw-muted" }, busy ? "正在载入…" : notice || (view === "logs" ? "仅保存在本机内存，不自动加入聊天。" : "点击加入当前会话草稿，发送后才可使用。")),
    view === "logs" ? logs && h("div", null,
      h("label", null, h("input", { type: "checkbox", checked: logs.enabled, onChange: event => void updateLogs({ enabled: event.target.checked }) }), "记录诊断"),
      h("div", { className: "dyw-actions" }, h("button", { onClick: exportLogs }, "导出"), h("button", { onClick: () => void updateLogs({ clear: true }) }, "清空"),
        h("button", { disabled: !sessionId || !logs.events.length, onClick: () => {
          const text = `<doyourweb_log>\n${JSON.stringify(logs, null, 2)}\n</doyourweb_log>`;
          setNotice(insertDraftReference(conversation, sessionId, { source: "doyourweb-context", ref: text, label: "诊断日志", appearance: "file", clipboardText: text }) ? "日志已加入当前草稿" : "当前草稿正在提交，请稍后再试。");
        } }, "引用到草稿")),
      h("p", { className: "dyw-muted" }, `${logs.events.length} / ${logs.capacity} 条 · 插件 ${logs.version}`),
      ...logs.events.slice().reverse().map((event, index) => h("details", { className: "dyw-event", key: index },
        h("summary", null, `${event.method} · ${event.code || event.phase}`, h("small", null, `${event.time.slice(11, 19)} · ${event.elapsedMs} ms · ${event.correlationId}`)), h("pre", null, JSON.stringify(event, null, 2)))))
      : h("ul", { className: "dyw-list" }, ...items.map(item => h("li", { key: item.ref }, h("button", { className: "dyw-object", disabled: !sessionId, onClick: () => pick(item) },
        h(IconGlobeOutlineRegular, { size: 16 }), h("span", null, h("strong", null, item.comment || item.displayName || item.title || item.name),
          h("small", null, view === "tabs" ? `${new URL(item.url).protocol === "file:" ? "本地 HTML" : new URL(item.url).hostname} · ${item.browser}` : item.title))))),
        !busy && !items.length && h("li", { className: "dyw-muted" }, view === "tabs" ? "暂无可引用网页" : "暂无可引用应用")),
    view !== "logs" && h("div", { className: "dyw-actions" }, h("button", { onClick: async () => {
      const result = await service()[view === "tabs" ? "setup" : "manage"]({});
      if (result.ok) window.open(result.value.url, "_blank", "noopener");
    } }, view === "tabs" ? "连接设置" : "应用管理")));
}

export function registerBrowserPanel(ctx) {
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
      return h("section", { className: "dyw-panel" }, h("h2", null, "引用详情"), h("pre", null, previews.get(sessionId) || "暂无引用内容"));
    }
    scope.effect(() => scope.sidebarRightTabs.register({ id: `${id}-context`, kind: `${id}-context`, priority: "extension", title: () => "引用详情" }));
    scope.slots.inject("sidebar.right.pane.tab", () => scope.slots.register({ name: "sidebar.right.pane.tab", key: `${id}-context`,
      inject: sessionId => ({ sessionId }) }, ContextPreview));
    scope.slots.inject("sidebar.right.pane.tab.title", () => scope.slots.register({ name: "sidebar.right.pane.tab.title", key: `${id}-context` }, () => h("span", null, "引用详情")));
    scope.effect(() => scope.uiConversation.userText.register(contextRule));
    scope.slots.inject("conversation.user.text.node", () => scope.slots.register({ name: "conversation.user.text.node", key: contextRule.id }, CompactContext));
    scope.effect(() => scope.sidebarRightTabs.register({ id, kind: id, priority: "extension", title: () => "浏览器" }));
    scope.slots.inject("sidebar.right.pane.tab", () => scope.slots.register({ name: "sidebar.right.pane.tab", key: id,
      inject: sessionId => ({ sessionId, service, conversation: scope.get("conversation") }) }, BrowserPanel));
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
      return current ? null : h(BrowserPanel, { service, conversation: scope.get("conversation") });
    }
    scope.slots.inject("main", () => scope.slots.register({ name: "main", key: id }, LaunchBrowser));
    scope.slots.inject("sidebar.panellist", () => scope.slots.register({ name: "sidebar.panellist", id, order: 25, label: "浏览器" }, IconGlobeOutlineRegular));
  });
}
