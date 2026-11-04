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
  host.style.cssText = 'all:initial;font:13px/1.5 "Segoe UI","Microsoft YaHei UI","Microsoft YaHei","Noto Sans CJK SC",sans-serif;color:var(--ink,#242424);color-scheme:light dark;position:fixed;right:16px;top:12px;max-width:calc(100vw - 16px);z-index:2147483647;display:flex;flex-direction:column;max-height:calc(100dvh - 16px);background:var(--ground,#fff);border-radius:12px;box-shadow:0 6px 24px #0002;overflow:hidden';
  const root = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  style.textContent = `:host{--ink:#242424;--muted:#666;--ground:#fff;--surface:#f4f4f4;--line:#d8d8d8;--focus:#0066cc;font:13px/1.5 "Segoe UI","Microsoft YaHei UI","Microsoft YaHei","Noto Sans CJK SC",sans-serif;color:var(--ink);color-scheme:light;display:flex;flex-direction:column;max-height:calc(100dvh - 16px);background:var(--ground);border-radius:12px;box-shadow:0 6px 24px #0002;overflow:hidden}*{box-sizing:border-box}button,input,textarea{font:inherit}button{display:inline-flex;align-items:center;justify-content:center;gap:5px;cursor:pointer;min-height:34px;border:1px solid var(--line);border-radius:6px;padding:6px 10px;background:var(--ground);color:var(--ink);white-space:nowrap}button svg{flex:none}button:hover{background:var(--surface)}button:focus-visible,textarea:focus-visible,input:focus-visible{outline:2px solid var(--focus);outline-offset:3px}button:disabled{cursor:wait;opacity:.5}button[aria-pressed=true],.primary{background:var(--ink);color:var(--ground);border-color:var(--ink)}.primary:hover{opacity:.85;background:var(--ink)}nav{display:flex;gap:6px;align-items:center;flex-wrap:wrap;width:min(400px,calc(100vw - 16px));padding:12px;background:var(--ground);border-radius:0;flex:none}strong{font-size:12px;font-weight:600;min-width:0;flex-basis:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-bottom:3px}nav>button:last-child{margin-left:auto;border-color:transparent}section{width:min(400px,calc(100vw - 16px));min-height:0;max-height:calc(100dvh - 180px);overflow:auto;overscroll-behavior:contain;margin-top:0;padding:16px;background:var(--ground);border-radius:0;border-top:1px solid var(--line);scrollbar-color:var(--line) var(--ground);scrollbar-width:thin}h2{font-size:14px;font-weight:600;margin:0 0 12px}code{display:block;background:var(--surface);color:var(--muted);border-radius:6px;padding:8px 10px;overflow-wrap:anywhere;font:12px/1.5 ui-monospace,monospace;max-height:54px;overflow:auto}textarea{display:block;width:100%;min-height:112px;max-height:30vh;resize:vertical;margin:12px 0;padding:10px;border:1px solid var(--line);border-radius:6px;background:var(--ground);color:var(--ink);line-height:1.6;caret-color:var(--ink)}textarea::placeholder{color:var(--muted)}::selection{background:var(--line);color:var(--ink)}footer{display:flex;gap:8px;align-items:center;justify-content:space-between;flex-wrap:wrap}label{display:flex;gap:5px;align-items:center;font-size:12px;color:var(--muted);margin-right:auto}input{accent-color:var(--ink);margin:0}output{display:block;flex:none;width:min(400px,calc(100vw - 16px));max-height:18vh;overflow:auto;overflow-wrap:anywhere;font-size:12px}output:not(:empty){margin-top:0;padding:10px 12px;background:var(--ground);color:var(--muted);border-radius:0;border-top:1px solid var(--line)}small{display:block;font-size:12px;color:var(--muted);margin-top:12px}.restore{min-height:40px;padding:8px 12px;background:var(--ground);border:0;border-radius:8px}.draft-list{margin-top:4px}.draft-row{display:flex;gap:6px;padding-top:6px}.draft-row button{border:0;background:var(--surface);min-height:32px}.draft-row .draft-edit{display:block;text-align:left;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.draft-row .draft-edit[aria-pressed=true]{color:var(--ink);outline:1px solid var(--line)}[hidden]{display:none!important}@media(prefers-color-scheme:dark){:host{--ink:#eee;--muted:#aaa;--ground:#202020;--surface:#2d2d2d;--line:#474747;--focus:#82b5ff;color-scheme:dark}}@media(max-width:440px){nav button{min-height:38px}nav{gap:5px}nav button{padding:6px 8px}footer{gap:6px}footer button{padding:6px 8px}}`;
  try {
    const sheet = new CSSStyleSheet(); sheet.replaceSync(style.textContent); root.adoptedStyleSheets = [sheet];
  } catch { root.append(style); }
  const nav = document.createElement("nav");
  const brand = document.createElement("strong"); brand.textContent = title;
  const select = document.createElement("button"); select.textContent = "批注"; select.title = "选择页面元素并批注";
  const collapse = document.createElement("button"); collapse.textContent = "收起"; collapse.title = "收起编辑区，保留批注工具栏"; collapse.setAttribute("aria-expanded", "true");
  const dock = document.createElement("button"); dock.textContent = "收纳"; dock.title = "收纳到页面边缘，保留未完成批注";
  const close = document.createElement("button"); close.textContent = "关闭"; close.title = "关闭批注工具并清除未完成批注";
  const icon = (button, path) => {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    for (const [name, value] of Object.entries({ width: "15", height: "15", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "1.5", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" })) svg.setAttribute(name, value);
    const shape = document.createElementNS(svg.namespaceURI, "path"); shape.setAttribute("d", path); svg.append(shape); button.prepend(svg);
  };
  icon(select, "m4 16-1 5 5-1L20 8l-4-4zM13 7l4 4");
  icon(dock, "M3 4v16M8 12h13m-5-5 5 5-5 5");
  close.setAttribute("aria-label", "关闭批注工具并清除未完成批注"); close.textContent = ""; icon(close, "m6 6 12 12M6 18 18 6");
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
  const stash = document.createElement("button"); stash.textContent = "暂存"; stash.title = "暂存当前批注，稍后继续编辑";
  const hint = document.createElement("small"); hint.textContent = "Enter 加入聊天草稿 · Shift+Enter 换行";
  const editor = document.createElement("div");
  const drafts = window.__dshAnnotationDraft?.notes || [];
  const draftList = document.createElement("div"); draftList.className = "draft-list";
  const draftHeading = document.createElement("small");
  footer.append(label, stash, save); editor.append(target, comment, footer, hint); panel.append(heading, editor, draftHeading, draftList);
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
  let selecting = false, selected = window.__dshAnnotationDraft?.selected, selectionEpoch = 0, dockSide = "right", sessionId, sessionTitle = title;
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
    panel.hidden = docked || collapsed || (!selected && !drafts.length);
    editor.hidden = !selected; target.textContent = selected?.selector || "";
    draftHeading.hidden = !drafts.length;
    draftHeading.textContent = `待加入聊天 · ${drafts.length} 条`;
    draftList.replaceChildren();
    for (const note of drafts) {
      const row = document.createElement("div"); row.className = "draft-row";
      const edit = document.createElement("button"); edit.className = "draft-edit"; edit.textContent = note.comment;
      edit.title = `${note.sessionTitle || "当前会话"} · ${note.selector} · 点击编辑`; edit.disabled = save.disabled;
      edit.setAttribute("aria-pressed", String(selected?.requestId === note.requestId));
      edit.onclick = () => {
        if (selected && comment.value.trim()) stage();
        stop(); selected = drafts.find(item => item.requestId === note.requestId); comment.value = selected.comment; screenshot.checked = selected.screenshot; collapsed = false; render(); keepVisible(); comment.focus();
        status.textContent = selected.sessionId && sessionId && selected.sessionId !== sessionId
          ? `此批注属于「${selected.sessionTitle}」，请切回原会话并重新开启批注后再加入。`
          : `正在编辑暂存批注 · ${selected.sessionTitle || "当前会话"}`;
      };
      const remove = document.createElement("button"); remove.title = "删除这条暂存批注"; remove.setAttribute("aria-label", "删除这条暂存批注"); remove.disabled = save.disabled;
      icon(remove, "M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7");
      remove.onclick = () => { drafts.splice(drafts.findIndex(item => item.requestId === note.requestId), 1); if (selected?.requestId === note.requestId) { selected = undefined; comment.value = ""; } render(); keepVisible(); (draftList.querySelector("button") || select).focus(); };
      row.append(edit, remove); draftList.append(row);
    }
    collapse.textContent = collapsed ? "展开" : "收起";
    collapse.title = collapsed ? "展开批注编辑区" : "收起编辑区，保留批注工具栏";
    collapse.setAttribute("aria-expanded", String(!collapsed));
  }
  function restoreWindow() {
    docked = false; render();
    if (expandedPosition) position(...expandedPosition); else keepVisible();
  }
  async function begin() {
    if (save.disabled) return;
    if (selected && comment.value.trim()) { stage(); comment.value = ""; }
    stop(); if (docked) restoreWindow(); collapsed = false; selected = undefined; render();
    const epoch = selectionEpoch;
    try {
      const target = await window[binding]({ action: "target" });
      if (epoch !== selectionEpoch || !host.isConnected || docked) return;
      brand.textContent = target.title; brand.title = `发送到会话：${target.title}`;
      sessionId = target.sessionId; sessionTitle = target.title;
      selecting = true; select.setAttribute("aria-pressed", "true"); status.textContent = "";
      status.textContent = "点击页面元素开始批注，Esc 退出选择。";
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
    selected = { ...describe(element), sessionId, sessionTitle }; stop(); target.textContent = selected.selector; status.textContent = ""; collapsed = false; render(); keepVisible(); comment.focus();
  }
  function blockPointer(event) { if (selecting && !event.composedPath().includes(host)) { event.preventDefault(); event.stopImmediatePropagation(); } }
  function keyboard(event) { if (event.key === "Escape" && !docked) { stop(); collapsed = true; render(); keepVisible(); collapse.focus(); } }
  function trusted(event, element) { try { return event.isTrusted && Event.prototype.composedPath.call(event).includes(element); } catch { return false; } }
  select.onclick = event => { if (trusted(event, select)) return selecting ? stop() : begin(); };
  collapse.onclick = () => { collapsed = !collapsed; stop(); render(); keepVisible(); };
  dock.onclick = () => {
    stop(); dragging = undefined;
    const box = host.getBoundingClientRect(); expandedPosition = [box.x, box.y];
    dockSide = box.x + box.width / 2 < innerWidth / 2 ? "left" : "right";
    docked = true; render(); keepVisible(); restore.focus();
  };
  restore.onclick = () => { restoreWindow(); (selected && !collapsed ? comment : select).focus(); };
  function stage() {
    const note = { ...selected, comment: comment.value.trim(), screenshot: screenshot.checked };
    const index = drafts.findIndex(item => item.requestId === note.requestId);
    if (index < 0) drafts.push(note); else drafts[index] = note;
  }
  stash.onclick = () => {
    if (!selected || !comment.value.trim()) { status.textContent = "请先选择元素并填写批注。"; return; }
    stage(); selected = undefined; comment.value = ""; status.textContent = "批注已暂存于本页，可编辑或删除；尚未加入聊天。"; render(); keepVisible(); select.focus();
  };
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
    select.disabled = stash.disabled = true;
    render();
    try {
      const value = { ...selected, comment: comment.value.trim(), screenshot: screenshot.checked };
      if (value.url !== location.href) throw new Error("页面已变化，请重新选择元素");
      if (value.screenshot) {
        if (value.shadow && (value.rect.scrollX !== scrollX || value.rect.scrollY !== scrollY)) throw new Error("页面已滚动，请重新选择元素后附截图。");
        if (!value.shadow) {
          const element = document.querySelector(value.selector);
          if (!element) throw new Error("元素已变化，请重新选择后附截图。");
          value.rect = describe(element).rect;
        }
      }
      host.style.visibility = "hidden";
      const result = await window[binding](value);
      status.textContent = `已加入 ${result.title} 草稿，回到聊天按 Enter 发送；可继续批注。`;
      const index = drafts.findIndex(item => item.requestId === selected.requestId);
      if (index >= 0) drafts.splice(index, 1);
      comment.value = ""; selected = undefined; render(); keepVisible();
    } catch (error) { status.textContent = error.message; }
    finally { host.style.visibility = ""; save.disabled = select.disabled = stash.disabled = false; render(); }
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
  window[key] = { host, select: begin, binding, close: close.onclick, draft: () => ({ comment: comment.value, screenshot: screenshot.checked, selected, notes: drafts, collapsed, docked, dockSide,
    position: docked ? expandedPosition : [host.getBoundingClientRect().x, host.getBoundingClientRect().y] }) };
  return active ? begin().then(() => ({ installed: true })) : { installed: true };
}
