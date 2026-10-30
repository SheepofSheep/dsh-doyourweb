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
  host.style.cssText = "all:initial;font:13px/1.5 system-ui,sans-serif;color:#233b34;position:fixed;right:16px;top:12px;z-index:2147483647";
  const root = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  style.textContent = `:host{font:13px/1.5 system-ui;color:#202124}*{box-sizing:border-box}button,input,textarea{font:inherit}button{cursor:pointer;border:1px solid #cbd0d6;border-radius:5px;padding:5px 9px;background:#fff;color:#202124}button:hover{background:#eef2f5}button[aria-pressed=true],.primary{background:#177a52;color:#fff;border-color:#177a52}nav{display:flex;gap:6px;align-items:center;padding:6px;background:#fff;border:1px solid #ccd2d8;border-radius:6px;box-shadow:0 2px 12px #0002}strong{font-size:12px;max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}section{width:min(350px,calc(100vw - 32px));margin-top:6px;padding:12px;background:#fff;border:1px solid #ccd2d8;border-radius:6px;box-shadow:0 2px 12px #0002}textarea{display:block;width:100%;min-height:85px;resize:vertical;padding:7px;border:1px solid #bcc5cd;border-radius:4px;margin:8px 0}code{display:block;overflow-wrap:anywhere;font-size:11px;max-height:50px;overflow:auto}footer{display:flex;gap:8px;align-items:center;justify-content:space-between}label{display:flex;gap:5px;align-items:center;font-size:12px}output{display:block;max-width:350px;overflow-wrap:anywhere;font-size:12px;margin-top:5px}[hidden]{display:none!important}`;
  style.textContent += "nav{max-width:calc(100vw - 32px);flex-wrap:wrap}strong{max-width:120px}";
  style.textContent += `:host{color:#233b34}button{border-color:#d5e0d9;border-radius:8px;padding:7px 10px;transition:background .12s}button:hover{background:#edf4ef}button:focus-visible,textarea:focus-visible{outline:2px solid #5b9e80;outline-offset:2px}button[aria-pressed=true],.primary{background:#1b7156;border-color:#1b7156;color:#fff}.primary:hover{background:#155d47}nav{gap:5px;padding:8px 10px;border-color:#d6e3da;border-radius:13px;box-shadow:0 6px 28px #153c2820}nav:before{content:'⠿';font-size:20px;color:#9bad9e;margin-right:3px}strong{font-weight:600;margin-right:6px}section{width:min(370px,calc(100vw - 32px));padding:16px;margin-top:8px;border-color:#d6e3da;border-radius:14px;box-shadow:0 10px 35px #153c2820}section:before{content:'页面批注';display:block;font-weight:600;font-size:14px;margin-bottom:10px}code{background:#f2f6f3;color:#62786b;border-radius:6px;padding:6px 8px;max-height:44px}textarea{min-height:108px;max-height:40vh;margin:12px 0;padding:10px;border-color:#d2ded6;border-radius:9px;line-height:1.6}textarea::placeholder{color:#85948b}label{color:#62786b}input{accent-color:#1b7156}footer{gap:12px}output:not(:empty){padding:9px 12px;background:#f3faf5;color:#35644c;border:1px solid #d6e3da;border-radius:9px;box-shadow:0 3px 14px #153c2810}small{display:block;font-size:11px;color:#86958b;margin-top:10px}@media(prefers-reduced-motion:reduce){button{transition:none}}`;
  try {
    const sheet = new CSSStyleSheet(); sheet.replaceSync(style.textContent); root.adoptedStyleSheets = [sheet];
  } catch { root.append(style); }
  const nav = document.createElement("nav");
  const brand = document.createElement("strong"); brand.textContent = title;
  const select = document.createElement("button"); select.textContent = "批注"; select.title = "选择页面元素并批注";
  const collapse = document.createElement("button"); collapse.textContent = "收起";
  const close = document.createElement("button"); close.textContent = "关闭";
  nav.append(brand, select, collapse, close);
  const panel = document.createElement("section"); panel.hidden = true;
  const target = document.createElement("code");
  const comment = document.createElement("textarea"); comment.placeholder = "填写这个元素需要修改的地方"; comment.maxLength = 4000; comment.setAttribute("aria-label", "批注内容");
  comment.value = window.__dshAnnotationDraft?.comment || "";
  const footer = document.createElement("footer");
  const label = document.createElement("label"); const screenshot = document.createElement("input"); screenshot.type = "checkbox";
  screenshot.checked = !!window.__dshAnnotationDraft?.screenshot;
  label.append(screenshot, "附局部截图");
  const save = document.createElement("button"); save.textContent = "加入聊天草稿"; save.className = "primary";
  const hint = document.createElement("small"); hint.textContent = "可连续添加多条，回到聊天后按 Enter 发送";
  footer.append(label, save); panel.append(target, comment, footer, hint);
  const status = document.createElement("output"); status.setAttribute("aria-live", "polite");
  root.append(nav, panel, status);
  document.documentElement.append(host);
  nav.style.touchAction = "none"; nav.style.cursor = "grab"; brand.title = "拖动浮窗";
  let dragging;
  function position(x, y) {
    const box = host.getBoundingClientRect();
    host.style.right = "auto";
    host.style.left = `${Math.max(0, Math.min(x, innerWidth - box.width))}px`;
    host.style.top = `${Math.max(0, Math.min(y, innerHeight - box.height))}px`;
  }
  function keepVisible() { const box = host.getBoundingClientRect(); position(box.x, box.y); }
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
  highlight.style.cssText = "position:fixed;pointer-events:none;border:2px solid #18a16a;background:#18a16a1a;z-index:2147483646;display:none";
  document.documentElement.append(highlight);
  let selecting = false, selected;
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
    return { requestId: crypto.randomUUID(), url: location.href, title: document.title, selector: selectorFor(element),
      tag: element.localName, role: element.getAttribute("role"), ariaLabel: element.getAttribute("aria-label"),
      text: (element.matches("input,textarea,[contenteditable]") ? "" : element.innerText || element.textContent || "").slice(0, 600),
      rect: { x: Math.max(0, box.left), y: Math.max(0, box.top), width: Math.max(0, Math.min(box.right, innerWidth) - Math.max(0, box.left)), height: Math.max(0, Math.min(box.bottom, innerHeight) - Math.max(0, box.top)), scrollX, scrollY },
      styles, shadow: element.getRootNode() instanceof ShadowRoot };
  }
  function stop() { selecting = false; select.setAttribute("aria-pressed", "false"); highlight.style.display = "none"; }
  async function begin() {
    stop(); selected = undefined; panel.hidden = true;
    try {
      const target = await window[binding]({ action: "target" });
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
    selected = describe(element); stop(); target.textContent = selected.selector; panel.hidden = false; keepVisible(); comment.focus();
  }
  function blockPointer(event) { if (selecting && !event.composedPath().includes(host)) { event.preventDefault(); event.stopImmediatePropagation(); } }
  function keyboard(event) { if (event.key === "Escape") { stop(); panel.hidden = true; } }
  function trusted(event, element) { try { return event.isTrusted && Event.prototype.composedPath.call(event).includes(element); } catch { return false; } }
  select.onclick = event => { if (trusted(event, select)) return selecting ? stop() : begin(); };
  collapse.onclick = () => { const hidden = brand.hidden = !brand.hidden; collapse.textContent = hidden ? "展开" : "收起"; panel.hidden = true; stop(); };
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
      comment.value = ""; selected = undefined; panel.hidden = true; keepVisible();
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
  window[key] = { host, select: begin, binding, close: close.onclick, draft: () => ({ comment: comment.value, screenshot: screenshot.checked, position: [host.getBoundingClientRect().x, host.getBoundingClientRect().y] }) };
  return active ? begin().then(() => ({ installed: true })) : { installed: true };
}
