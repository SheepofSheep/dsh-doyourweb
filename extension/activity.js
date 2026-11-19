// Visual feedback runs in the isolated world. Stopping an operation belongs to
// the extension popup, outside the page's hit-testing and navigation lifetime.
export function installActivity() {
  window.__dshActivity?.close();
  const host = document.createElement("div");
  host.dataset.dshActivity = "";
  host.setAttribute("aria-hidden", "true");
  host.style.cssText = "all:initial;position:fixed;inset:0;pointer-events:none!important;z-index:2147483647";
  const root = host.attachShadow({ mode: "closed" });
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(`
    *{box-sizing:border-box;pointer-events:none}
    span{position:absolute;top:8px;right:8px;max-width:calc(100% - 16px);padding:4px 8px;border-radius:8px;background:#242424ed;color:#fff;font:12px/1.5 "Segoe UI","Microsoft YaHei UI","Microsoft YaHei",sans-serif}
    @media(prefers-color-scheme:dark){span{background:#eee;color:#222}}
    @media(prefers-reduced-motion:no-preference){span{animation:arrive 150ms ease-out}@keyframes arrive{from{opacity:0;transform:translateY(-2px)}to{opacity:1;transform:translateY(0)}}}
  `);
  root.adoptedStyleSheets = [sheet];
  const label = document.createElement("span");
  label.textContent = "DSH 正在操作 · 从扩展菜单停止";
  root.append(label);
  document.documentElement.append(host);
  window.__dshActivity = {
    close() { host.remove(); delete window.__dshActivity; },
  };
}
