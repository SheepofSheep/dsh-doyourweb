// Runs in a private CDP isolated world. The page cannot call the stop binding or
// rewrite the closed shadow controls. isTrusted only rejects scripted clicks;
// it is deliberately NOT used to guess whether input came from a human or CDP.
export function installActivity(binding) {
  window.__dshActivity?.close();
  const host = document.createElement("div");
  host.dataset.dshActivity = "";
  host.setAttribute("aria-hidden", "true");
  host.style.cssText = "all:initial;position:fixed;top:12px;right:16px;z-index:2147483647";
  const root = host.attachShadow({ mode: "closed" });
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(`*{box-sizing:border-box}nav{display:flex;align-items:center;gap:12px;max-width:calc(100vw - 32px);padding:9px 12px;border:1px solid #b7d6c9;border-radius:24px;background:#f4fff9f5;color:#214c3a;box-shadow:0 4px 20px #183c2630;font:13px/1.5 system-ui,sans-serif}button{font:inherit;border:1px solid #dcb9b4;background:#fff4f2;color:#922e24;border-radius:18px;padding:4px 10px;cursor:pointer}button:focus-visible{outline:2px solid #922e24;outline-offset:2px}.ring{position:fixed;pointer-events:none;border:2px solid #1a9562;background:#1a956217;border-radius:6px;animation:pulse .3s ease-out forwards}@keyframes pulse{from{opacity:1;box-shadow:0 0 0 0 #1a956270}to{opacity:0;box-shadow:0 0 0 9px #1a956200}}@media(prefers-reduced-motion:reduce){.ring{animation:none}}`);
  root.adoptedStyleSheets = [sheet];
  const nav = document.createElement("nav");
  const label = document.createElement("span"); label.textContent = "DSH 正在操作此页面";
  const stop = document.createElement("button"); stop.textContent = "停止"; stop.type = "button";
  stop.onclick = event => {
    if (!event.isTrusted) return;
    stop.disabled = true; label.textContent = "正在停止…"; window[binding](JSON.stringify({ action: "stop" }));
  };
  nav.append(label, stop); root.append(nav); document.documentElement.append(host);
  window.__dshActivity = {
    pulse(box) {
      const ring = document.createElement("div"); ring.className = "ring";
      Object.assign(ring.style, { left: `${box.x}px`, top: `${box.y}px`, width: `${box.width}px`, height: `${box.height}px` });
      root.append(ring); setTimeout(() => ring.remove(), 350);
    },
    close() { host.remove(); delete window.__dshActivity; },
  };
}
