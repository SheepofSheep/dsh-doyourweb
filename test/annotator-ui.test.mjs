import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright-core";
import { installAnnotator } from "../extension/annotator.js";

test("annotation collapse, edge storage and restoration preserve drafts without intercepting the page", {
  skip: !existsSync(chromium.executablePath()) && "Chromium is not installed",
}, async t => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const sent = [];
  let targetReply;
  await page.exposeFunction("annotationBinding", value => {
    if (value.action === "target") return targetReply ? new Promise(resolve => { targetReply = resolve; }) : { title: "前端调整" };
    sent.push(value); return { title: "前端调整", accepted: true };
  });
  await page.setContent('<title>批注测试</title><style>body{margin:48px;font:16px system-ui;background:#fafafa;color:#252525}button{padding:12px}h1{font-size:24px}</style><h1>页面设置</h1><button id="subject" onclick="this.dataset.clicks=String(+(this.dataset.clicks||0)+1)">保存设置</button>');
  // The fixture captures the closed root at creation so tests can inspect controls;
  // production continues to use a closed shadow root and native trusted events.
  await page.evaluate(() => {
    const attach = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function (options) {
      const root = attach.call(this, options);
      if (this.dataset.dshAnnotation) window.annotationTestRoot = root;
      return root;
    };
  });
  const install = active => page.evaluate(`(${installAnnotator.toString()})({binding:"annotationBinding",active:${active}})`);
  const inspect = (selector, fn, value) => page.evaluate(({ selector, source, value }) => {
    const element = window.annotationTestRoot.querySelector(selector);
    if (!element) throw new Error(`Missing annotation control: ${selector}`);
    return (0, eval)(`(${source})`)(element, value);
  }, { selector, source: fn.toString(), value });
  const click = async selector => {
    const point = await inspect(selector, element => { const box = element.getBoundingClientRect(); return { x: box.x + box.width / 2, y: box.y + box.height / 2 }; });
    await page.mouse.click(point.x, point.y);
  };
  const control = label => `button[title="${label}"]`;
  const box = () => page.locator('[data-dsh-annotation="toolbar"]').boundingBox();
  await install(true);
  await page.locator("#subject").click();
  assert.equal(await page.locator("#subject").getAttribute("data-clicks"), null, "picking must not activate the page");
  await inspect("textarea", element => { element.value = "保留这个未完成批注"; });
  await inspect("input", element => { element.checked = true; });
  const draft = await inspect("textarea", element => element.value);

  await click(control("收起编辑区，保留批注工具栏"));
  assert.equal(await inspect("section", element => element.hidden), true);
  assert.equal(await inspect("strong", element => element.hidden), false, "collapse retains the toolbar identity");
  await click(control("展开批注编辑区"));
  assert.equal(await inspect("section", element => element.hidden), false);
  assert.equal(await inspect("textarea", element => element.value), draft);
  assert.equal(await inspect("code", element => element.textContent), "#subject");

  const grip = await inspect("strong", element => { const box = element.getBoundingClientRect(); return { x: box.x + 10, y: box.y + 8 }; });
  await page.mouse.move(grip.x, grip.y); await page.mouse.down();
  await page.mouse.move(grip.x - 230, grip.y + 100, { steps: 5 }); await page.mouse.up();
  const original = await box();
  await click(control("收纳到页面边缘，保留未完成批注"));
  const stored = await box();
  assert.ok(stored.width < 90 && stored.height < 60, "storage leaves only the edge button");
  assert.ok(stored.x === 0 || stored.x + stored.width === 1280);
  await page.locator("#subject").click();
  assert.equal(await page.locator("#subject").getAttribute("data-clicks"), "1");
  await page.keyboard.press("Enter");
  assert.equal(sent.length, 0);
  assert.equal(await page.locator("#subject").getAttribute("data-clicks"), "2", "stored toolbar also leaves page keyboard activation available");
  await click(".restore");
  const restored = await box();
  assert.equal(restored.x, original.x); assert.equal(restored.y, original.y);
  assert.equal(await inspect("textarea", element => element.value), draft);
  assert.equal(await inspect("input", element => element.checked), true);
  assert.equal(await inspect("section", element => element.hidden), false);

  if (process.env.DSH_TEST_ARTIFACTS) {
    await mkdir(process.env.DSH_TEST_ARTIFACTS, { recursive: true });
    await page.screenshot({ path: path.join(process.env.DSH_TEST_ARTIFACTS, "annotation-desktop.png") });
  }
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => window.annotationTestRoot.querySelector("output").textContent.includes("已加入"));
  assert.equal(sent.length, 1); assert.equal(sent[0].comment, draft); assert.equal(sent[0].screenshot, true);
  await click(control("选择页面元素并批注"));
  await page.locator("h1").click();
  await inspect("textarea", element => { element.value = "第二条批注"; });
  await click(".primary");
  await page.waitForFunction(() => window.annotationTestRoot.querySelector("textarea").value === "");
  assert.equal(sent.length, 2);

  // Store during an in-flight target lookup. Its late reply must not re-enable
  // picking and swallow normal page input after the window has been stored.
  targetReply = true;
  await click(control("选择页面元素并批注"));
  await click(control("收纳到页面边缘，保留未完成批注"));
  targetReply({ title: "前端调整" }); targetReply = undefined;
  await page.locator("#subject").click();
  assert.equal(await page.locator("#subject").getAttribute("data-clicks"), "3");
  await click(".restore");
  assert.equal(await inspect('button[aria-pressed]', element => element.getAttribute("aria-pressed")), "false");

  await click(control("选择页面元素并批注"));
  await page.locator("#subject").click();
  await inspect("textarea", element => { element.value = "窄屏上的未完成草稿"; });
  for (const width of [768, 390, 320]) {
    await page.setViewportSize({ width, height: 620 });
    await page.waitForFunction(() => {
      const box = window.__dshAnnotationToolbar.host.getBoundingClientRect();
      return box.x >= 0 && box.y >= 0 && box.right <= innerWidth && box.bottom <= innerHeight;
    });
    const visible = await box();
    assert.ok(visible.x >= 0 && visible.y >= 0 && visible.x + visible.width <= width && visible.y + visible.height <= 620,
      `floating editor fits ${width}px viewport`);
    if (process.env.DSH_TEST_ARTIFACTS && width === 390) await page.screenshot({ path: path.join(process.env.DSH_TEST_ARTIFACTS, "annotation-mobile.png") });
  }
  await click(control("收纳到页面边缘，保留未完成批注"));
  // This is the same draft handoff used when the annotation CDP binding detaches.
  await page.evaluate(() => { const ui = window.__dshAnnotationToolbar; const draft = ui.draft(); ui.close(); window.__dshAnnotationDraft = draft; });
  await install(false);
  assert.equal(await inspect(".restore", element => element.hidden), false);
  assert.equal(await inspect("textarea", element => element.value), "窄屏上的未完成草稿");
  await click(".restore");
  assert.equal(sent.length, 2, "restoration never submits a draft");
  await click(control("选择页面元素并批注"));
  await page.locator("h1").click();
  assert.equal(await inspect("textarea", element => element.value), "窄屏上的未完成草稿");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => window.annotationTestRoot.querySelector("textarea").value === "");
  assert.equal(sent.length, 3);
});
