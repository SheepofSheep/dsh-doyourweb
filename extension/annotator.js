// Evaluated in the selected document; all communication stays on its paired host binding.
export function installAnnotator({ binding, title = "DSH DoYourWeb", active = false }) {
  if (window !== window.top) return;
  if (!document.documentElement) { document.addEventListener("DOMContentLoaded", () => installAnnotator({ binding, title, active }), { once: true }); return; }
  const key = "__dshAnnotationToolbar";
  if (window[key]?.host?.isConnected) {
    if (window[key].binding === binding) return active ? window[key].select().then(() => ({ installed: true })) : { installed: true };
    window[key].close();
  }
  const host = document.createElement("div");
  host.dataset.dshAnnotation = "toolbar";
  host.style.cssText = "all:initial;font:13px/1.5 system-ui,sans-serif;color:#252525;position:fixed;right:16px;top:12px;max-width:calc(100vw - 16px);z-index:2147483647";
  const root = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  style.textContent = `:host{font:13px/1.5 system-ui,sans-serif;color:#252525;color-scheme:light}*{box-sizing:border-box}button,input,textarea{font:inherit}button{cursor:pointer;min-height:34px;border:1px solid #d4d4d4;border-radius:8px;padding:6px 10px;background:#fff;color:#303030;white-space:nowrap}button:hover{background:#f2f2f2}button:active{background:#e8e8e8}button:focus-visible,textarea:focus-visible,input:focus-visible{outline:2px solid #555;outline-offset:2px}button:disabled{cursor:wait;background:#ededed;color:#626262}button[aria-pressed=true],.primary{background:#292929;color:#fff;border-color:#292929}.primary:hover{background:#414141}nav{display:flex;gap:4px;align-items:center;flex-wrap:wrap;max-width:calc(100vw - 16px);padding:8px;background:#fff;border-radius:12px;box-shadow:0 4px 20px #0002}strong{font-size:12px;font-weight:600;min-width:0;max-width:132px;margin:0 4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}section{width:min(370px,calc(100vw - 16px));max-height:calc(100vh - 88px);overflow:auto;overscroll-behavior:contain;margin-top:8px;padding:16px;background:#fff;border-radius:12px;box-shadow:0 6px 24px #0002;scrollbar-color:#b5b5b5 #f4f4f4;scrollbar-width:thin}h2{font-size:14px;font-weight:600;margin:0 0 10px}code{display:block;background:#f5f5f5;color:#606060;border-radius:6px;padding:7px 9px;overflow-wrap:anywhere;font:12px/1.5 ui-monospace,monospace;max-height:54px;overflow:auto}textarea{display:block;width:100%;min-height:108px;max-height:36vh;resize:vertical;margin:12px 0;padding:10px;border:1px solid #ccc;border-radius:8px;background:#fff;color:#252525;line-height:1.6;caret-color:#252525}textarea::placeholder{color:#686868}::selection{background:#dedede;color:#171717}footer{display:flex;gap:12px;align-items:center;justify-content:space-between;flex-wrap:wrap}label{display:flex;gap:6px;align-items:center;font-size:12px;color:#606060}input{accent-color:#303030;margin:0}output{display:block;width:min(370px,calc(100vw - 16px));max-height:25vh;overflow:auto;overflow-wrap:anywhere;font-size:12px}output:not(:empty){margin-top:8px;padding:10px 12px;background:#f5f5f5;color:#454545;border-radius:8px;box-shadow:0 3px 14px #0001}small{display:block;font-size:12px;color:#686868;margin-top:10px}.restore{min-height:40px;padding:8px 12px;background:#fff;box-shadow:0 3px 16px #0002;border:0;border-radius:10px}[hidden]{display:none!important}@media(max-width:440px){nav button{min-height:40px}strong{flex-basis:100%;max-width:100%;padding:0 2px;margin-bottom:2px}section{max-height:calc(100vh - 120px)}footer .primary{flex:1}}`;
  try {
    const sheet = new CSSStyleSheet(); sheet.replaceSync(style.textContent); root.adoptedStyleSheets = [sheet];
  } catch { root.append(style); }
  const nav = document.createElement("nav");
  const brand = document.createElement("strong"); brand.textContent = title;
  const select = document.createElement("button"); select.textContent = "批注"; select.title = "选择页面元素并批注";
  const collapse = document.createElement("button"); collapse.textContent = "收起"; collapse.title = "收起编辑区，保留批注工具栏"; collapse.setAttribute("aria-expanded", "true");
  const dock = document.createElement("button"); dock.textContent = "收纳"; dock.title = "收纳到页面边缘，保留未完成批注";
  const close = document.createElement("button"); close.textContent = "关闭"; close.title = "关闭批注工具并清除未完成批注";
  nav.append(brand, select, collapse, dock, close);
  const panel = document.createElement("section"); panel.hidden = true;
  const heading = document.createElement("h2"); heading.textContent = "页面批注";
  const target = document.createElement("code");
  const comment = document.createElement("textarea"); comment.placeholder = "填写这个元素需要修改的地方"; comment.maxLength = 4000; comment.setAttribute("aria-label", "批注内容");
  comment.value = window.__dshAnnotationDraft?.comment || "";
  const footer = document.createElement("footer");
  const label = document.createElement("label"); const screenshot = document.createElement("input"); screenshot.type = "checkbox";
  screenshot.checked = !!window.__dshAnnotationDraft?.screenshot;
  label.append(screenshot, "附局部截图");
  const save = document.createElement("button"); save.textContent = "加入聊天草稿"; save.className = "primary"; save.title = "将当前批注加入聊天草稿";
  const hint = document.createElement("small"); hint.textContent = "可连续添加多条，回到聊天后按 Enter 发送";
  footer.append(label, save); panel.append(heading, target, comment, footer, hint);
  const status = document.createElement("output"); status.setAttribute("aria-live", "polite");
  const restore = document.createElement("button"); restore.className = "restore"; restore.textContent = "批注"; restore.title = "恢复批注浮窗与未完成草稿"; restore.setAttribute("aria-label", "恢复批注浮窗"); restore.hidden = true;
  root.append(nav, panel, status, restore);
  document.documentElement.append(host);
  nav.style.touchAction = "none"; nav.style.cursor = "grab"; brand.title = "拖动浮窗";
  let dragging, docked = false, collapsed = false, expandedPosition;
  function position(x, y) {
    const box = host.getBoundingClientRect();
    host.style.right = "auto";
    host.style.left = `${Math.max(0, Math.min(x, innerWidth - box.width))}px`;
    host.style.top = `${Math.max(0, Math.min(y, innerHeight - box.height))}px`;
  }
  function keepVisible() { const box = host.getBoundingClientRect(); position(docked ? (dockSide === "left" ? 0 : innerWidth - box.width) : box.x, box.y); }
  nav.onpointerdown = event => {
    if (!event.isTrusted || event.button !== 0 || event.target.closest("button")) return;
    const box = host.getBoundingClientRect(); dragging = { x: event.clientX - box.x, y: event.clientY - box.y };
    nav.setPointerCapture(event.pointerId); nav.style.cursor = "grabbing"; event.preventDefault();
  };
  nav.onpointermove = event => { if (dragging) position(event.clientX - dragging.x, event.clientY - dragging.y); };
  nav.onpointerup = nav.onpointercancel = nav.onlostpointercapture = () => { dragging = undefined; nav.style.cursor = "grab"; };
  window.addEventListener("resize", keepVisible);
  if (window.__dshAnnotationDraft?.position) position(...window.__dshAnnotationDraft.position);
  const highlight = document.createElement("div");
  highlight.style.cssText = "position:fixed;pointer-events:none;border:2px solid #666;background:#7771;z-index:2147483646;display:none";
  document.documentElement.append(highlight);
  let selecting = false, selected, selectionEpoch = 0, dockSide = "right";
  const escape = value => CSS.escape(value);
  function selectorFor(element) {
    if (element.id && document.querySelectorAll(`#${escape(element.id)}`).length === 1) return `#${escape(element.id)}`;
    const parts = [];
    for (let current = element; current?.nodeType === 1 && parts.length < 7; current = current.parentElement) {
      let part = current.localName;
      if (current.id) { parts.unshift(`#${escape(current.id)}`); break; }
      const siblings = current.parentElement ? [...current.parentElement.children].filter(item => item.localName === current.localName) : [];
      if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
      parts.unshift(part);
    }
    return parts.join(" > ");
  }
  function describe(element) {
    const box = element.getBoundingClientRect();
    const computed = getComputedStyle(element);
    // Bounds already carry width/height. Keep typography and layout useful for
    // design edits, while omitting empty/default spacing and stacking values.
    const styles = Object.fromEntries(["display", "position", "visibility", "zIndex", "margin", "padding", "color", "backgroundColor", "fontSize", "fontFamily", "gap", "alignItems", "justifyContent"]
      .map(name => [name, computed[name]]).filter(([name, value]) => value && !({ position: "static", visibility: "visible", zIndex: "auto", margin: "0px", padding: "0px", gap: "normal", alignItems: "normal", justifyContent: "normal" }[name] === value)));
    // randomUUID is unavailable on ordinary HTTP pages; getRandomValues also
    // works there, so annotation selection keeps working outside secure origins.
    const requestBytes = crypto.getRandomValues(new Uint8Array(16));
    requestBytes[6] = (requestBytes[6] & 15) | 64; requestBytes[8] = (requestBytes[8] & 63) | 128;
    const requestHex = [...requestBytes].map(value => value.toString(16).padStart(2, "0")).join("");
    const requestId = `${requestHex.slice(0, 8)}-${requestHex.slice(8, 12)}-${requestHex.slice(12, 16)}-${requestHex.slice(16, 20)}-${requestHex.slice(20)}`;
    return { requestId, url: location.href, title: document.title, selector: selectorFor(element),
      tag: element.localName, role: element.getAttribute("role"), ariaLabel: element.getAttribute("aria-label"),
      text: (element.matches("input,textarea,[contenteditable]") ? "" : element.innerText || element.textContent || "").slice(0, 600),
      rect: { x: Math.max(0, box.left), y: Math.max(0, box.top), width: Math.max(0, Math.min(box.right, innerWidth) - Math.max(0, box.left)), height: Math.max(0, Math.min(box.bottom, innerHeight) - Math.max(0, box.top)), scrollX, scrollY },
      styles, shadow: element.getRootNode() instanceof ShadowRoot };
  }
  function stop() { selectionEpoch++; selecting = false; select.setAttribute("aria-pressed", "false"); highlight.style.display = "none"; }
  function render() {
    nav.hidden = docked; restore.hidden = !docked; status.hidden = docked;
    panel.hidden = docked || collapsed || !selected;
    collapse.textContent = collapsed ? "展开" : "收起";
    collapse.title = collapsed ? "展开批注编辑区" : "收起编辑区，保留批注工具栏";
    collapse.setAttribute("aria-expanded", String(!collapsed));
  }
  function restoreWindow() {
    docked = false; render();
    if (expandedPosition) position(...expandedPosition); else keepVisible();
  }
  async function begin() {
    stop(); if (docked) restoreWindow(); collapsed = false; selected = undefined; render();
    const epoch = selectionEpoch;
    try {
      const target = await window[binding]({ action: "target" });
      if (epoch !== selectionEpoch || !host.isConnected || docked) return;
      brand.textContent = target.title; brand.title = `发送到会话：${target.title}`;
      selecting = true; select.setAttribute("aria-pressed", "true"); status.textContent = "";
    } catch (error) { status.textContent = error.message; }
  }
  function move(event) {
    if (!selecting || event.composedPath().includes(host)) return;
    const element = event.composedPath().find(item => item instanceof Element);
    if (!element || element === highlight) return;
    const box = element.getBoundingClientRect();
    Object.assign(highlight.style, { display: "block", left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, height: `${box.height}px` });
  }
  function pick(event) {
    if (!selecting || event.composedPath().includes(host)) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (!event.isTrusted) return;
    const element = event.composedPath().find(item => item instanceof Element);
    if (!element) return;
    selected = describe(element); stop(); target.textContent = selected.selector; collapsed = false; render(); keepVisible(); comment.focus();
  }
  function blockPointer(event) { if (selecting && !event.composedPath().includes(host)) { event.preventDefault(); event.stopImmediatePropagation(); } }
  function keyboard(event) { if (event.key === "Escape" && !docked) { stop(); collapsed = true; render(); keepVisible(); } }
  function trusted(event, element) { try { return event.isTrusted && Event.prototype.composedPath.call(event).includes(element); } catch { return false; } }
  select.onclick = event => { if (trusted(event, select)) return selecting ? stop() : begin(); };
  collapse.onclick = () => { collapsed = !collapsed; stop(); render(); keepVisible(); };
  dock.onclick = () => {
    stop(); dragging = undefined;
    const box = host.getBoundingClientRect(); expandedPosition = [box.x, box.y];
    dockSide = box.x + box.width / 2 < innerWidth / 2 ? "left" : "right";
    docked = true; render(); keepVisible(); restore.focus();
  };
  restore.onclick = () => { restoreWindow(); (panel.hidden ? select : comment).focus(); };
  close.onclick = () => {
    stop(); document.removeEventListener("pointermove", move, true); document.removeEventListener("click", pick, true);
    document.removeEventListener("keydown", keyboard, true); host.remove(); highlight.remove(); delete window[key];
    delete window.__dshAnnotationDraft;
    window.removeEventListener("resize", keepVisible);
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup"]) document.removeEventListener(type, blockPointer, true);
  };
  async function saveAnnotation(event, control) {
    if (!trusted(event, control) || save.disabled) return;
    if (!selected || !comment.value.trim()) { status.textContent = "请先选择元素并填写批注。"; return; }
    save.disabled = true;
    try {
      const value = { ...selected, comment: comment.value.trim(), screenshot: screenshot.checked };
      if (value.url !== location.href) throw new Error("页面已变化，请重新选择元素");
      host.style.visibility = "hidden";
      const result = await window[binding](value);
      status.textContent = `已加入 ${result.title} 草稿，回到聊天按 Enter 发送；可继续批注。`;
      comment.value = ""; selected = undefined; render(); keepVisible();
    } catch (error) { status.textContent = error.message; }
    finally { host.style.visibility = ""; save.disabled = false; }
  }
  save.onclick = event => saveAnnotation(event, save);
  comment.addEventListener("keydown", event => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault(); event.stopPropagation(); void saveAnnotation(event, comment);
    }
  });
  comment.placeholder = "填写修改说明；Enter 加入草稿，Shift+Enter 换行";
  document.addEventListener("pointermove", move, true); document.addEventListener("click", pick, true); document.addEventListener("keydown", keyboard, true);
  for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup"]) document.addEventListener(type, blockPointer, true);
  collapsed = !!window.__dshAnnotationDraft?.collapsed;
  if (window.__dshAnnotationDraft?.docked) {
    expandedPosition = window.__dshAnnotationDraft.position; docked = true; dockSide = window.__dshAnnotationDraft.dockSide || "right";
  }
  render(); keepVisible();
  window[key] = { host, select: begin, binding, close: close.onclick, draft: () => ({ comment: comment.value, screenshot: screenshot.checked, collapsed, docked, dockSide,
    position: docked ? expandedPosition : [host.getBoundingClientRect().x, host.getBoundingClientRect().y] }) };
  return active ? begin().then(() => ({ installed: true })) : { installed: true };
}
