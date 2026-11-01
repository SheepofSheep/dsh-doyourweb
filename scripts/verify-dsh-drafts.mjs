import { readFile } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { chromium } from "playwright-core";

// Exercise the installed DSH editor, including its chip coordinates, in a disposable browser.
export async function verifyDraftInput(bundle, root) {
  const dependencies = await build({ stdin: { contents: `import * as zod from 'zod'; import * as cordis from '@deepseek-ai/cordis'; window.testDeps={zod,cordis};`, resolveDir: root }, bundle: true, platform: "browser", write: false });
  const helper = await build({ entryPoints: [path.join(root, "src/annotation-drafts.js")], bundle: true, format: "iife", globalName: "draftHelper", write: false });
  const source = (await readFile(bundle, "utf8")).replace("exports.Config = Config;", "exports.TestShell = SessionInputShell; exports.Config = Config;");
  const browser = await chromium.launch({ headless: true, channel: "chromium" });
  try {
    const page = await browser.newPage();
    await page.addScriptTag({ content: dependencies.outputFiles[0].text });
    await page.evaluate(() => {
      const react = { memo: x => x, forwardRef: x => x, createContext: () => ({}), createElement: () => null, Component: class {}, PureComponent: class {} };
      const store = { createSnapshotStore(value) {
        const listeners = new Set();
        return { getSnapshot: () => value, set(v) { value = v; for (const listener of listeners) listener(); }, subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); } };
      } };
      window.__ModuleLoader__ = { load(entry) { window.factory = entry.factory; } };
      window.deps = { react, "react/jsx-runtime": {}, "react-dom": {}, zod: window.testDeps.zod,
        "@deepseek-ai/cordis": window.testDeps.cordis, "@deepseek-ai/dsh-client-store": store,
        "@deepseek-ai/dsh-client-ui-primitives": {}, "@deepseek-ai/dsh-client-ui-slots": {} };
    });
    await page.addScriptTag({ content: source });
    await page.addScriptTag({ content: helper.outputFiles[0].text });
    const result = await page.evaluate(() => {
      const module = window.factory(id => { if (!(id in window.deps)) throw new Error(id); return window.deps[id]; });
      let submissions = 0;
      const shell = new module.TestShell({ inputTriggers: () => undefined, defaultSink: () => { submissions++; } });
      const reference = { source: "browser-tabs", ref: "dsh-browser://test/1", label: "Test page", clipboardText: "@[Test page](dsh-browser://test/1)", offset: 4, length: 1 };
      shell.setDraft({ text: `Use ${reference.clipboardText}`, references: [reference] });
      shell.actions.addAttachments(["existing-image"]);
      const conversation = { input: { shell: () => shell }, draftAttachments: new Map(),
        createDrafts: module.ConversationController.prototype.createDrafts,
        releaseDraftAttachment: module.ConversationController.prototype.releaseDraftAttachment };
      const first = window.draftHelper.appendAnnotationDraft(conversation, { sessionId: "s", content: [{ type: "text", text: "First note" }, { type: "image", mediaType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j4N8AAAAASUVORK5CYII=" }] });
      const second = window.draftHelper.appendAnnotationDraft(conversation, { sessionId: "s", content: [{ type: "text", text: "Second note" }] });
      const state = shell.state.getSnapshot();
      return { first, second, draft: state.draft, references: shell.draftSnapshot.references, attachments: state.attachmentIds, submissions };
    });
    assert.equal(result.first, true); assert.equal(result.second, true);
    assert.match(result.draft, /^Use @\[Test page\].*First note.*Second note/s);
    assert.equal(result.references.length, 3); assert.equal(result.references[0].ref, "dsh-browser://test/1");
    assert.equal(result.references[1].source, "doyourweb-context");
    assert.match(result.references[1].ref, /First note/);
    assert.equal(result.attachments[0], "existing-image"); assert.equal(result.attachments.length, 2);
    assert.equal(result.submissions, 0);
    console.log("PASS: installed DSH editor accumulates annotation drafts and images, preserves reference chips and attachments, and does not auto-submit.");
  } finally { await browser.close(); }
}
