import { randomUUID } from "node:crypto";
import path from "node:path";
import { mkdir, stat, access, realpath, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { canControl } from "./protocol.js";
import { clip, serialize } from "./output.js";
import { browserActivity } from "./activity.js";
import { NetworkCapture } from "./network.js";
import { CaptureStore } from "./captures.js";

export function pageChunk(snapshot, offset = 0, limit = 2400) {
  if (!Number.isInteger(offset) || offset < 0 || offset > snapshot.text.length) throw new Error("Invalid snapshot cursor");
  const end = Math.min(snapshot.text.length, offset + limit);
  const newline = snapshot.text.lastIndexOf("\n", end - 1);
  const boundary = end < snapshot.text.length && newline > offset ? newline + 1 : end;
  return {
    snapshot: snapshot.id, url: snapshot.url, title: snapshot.title,
    content: snapshot.text.slice(offset, boundary),
    ...(boundary < snapshot.text.length ? { cursor: `${snapshot.id}:${boundary}`, omittedChars: snapshot.text.length - boundary } : {}),
  };
}

function boundedChunk(state, offset, limit, extra) {
  const metadata = { ...state, title: clip(state.title, Math.min(128, Math.floor(limit / 10))),
    url: clip(state.url, Math.min(512, Math.floor(limit / 5))) };
  let truncated = metadata.title !== state.title || metadata.url !== state.url;
  const result = length => ({ ...extra, ...pageChunk(metadata, offset, length),
    ...(truncated ? { metadataTruncated: true } : {}) });
  const minimum = offset < state.text.length ? 1 : 0;
  // Reserve metadata and cursor first, then fit the JSON-escaped text. Raw
  // character limits alone miss long titles, URLs, quotes and context escaping.
  for (const field of ["title", "url"]) {
    if (serialize(result(minimum)).length <= limit) break;
    metadata[field] = undefined;
    truncated = true;
  }
  if (serialize(result(minimum)).length > limit) throw new Error("Output budget is too small for the action receipt; increase limit");
  let low = minimum, high = Math.min(state.text.length - offset, limit);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (serialize(result(middle)).length <= limit) low = middle;
    else high = middle - 1;
  }
  return result(low);
}

function checkpoint(signal) { signal?.throwIfAborted(); }

function boundedExtraction(index, data, limit) {
  const result = { index, rows: data.rows, omittedRows: data.totalRows - data.rows.length,
    ...(data.truncated ? { truncated: true } : {}) };
  const dropRow = () => { result.rows.pop(); result.omittedRows++; };
  if (serialize(result).length <= limit) return result;
  result.truncated = true;
  while (result.rows.length > 1 && serialize(result).length > limit) dropRow();
  if (result.rows.length) {
    for (let size = 100; serialize(result).length > limit && size >= 4; size = Math.floor(size / 2)) {
      for (const key of Object.keys(result.rows[0])) result.rows[0][key] = clip(result.rows[0][key], size);
    }
    if (serialize(result).length > limit) dropRow();
  }
  return result;
}

function boundAction(result, cap = 1400) {
  const budget = Math.max(400, Math.min(8000, cap));
  for (const [object, key] of [[result.failure, "error"], [result.expectation, "error"], [result, "readError"], [result, "url"]]) {
    while (serialize(result).length > budget && object?.[key]?.length > 16) {
      object[key] = clip(object[key], Math.floor(object[key].length / 2));
      if (key === "url") result.metadataTruncated = true;
    }
  }
  while (serialize(result).length > budget) {
    const entry = result.results?.filter(entry => entry.rows?.length)
      .sort((a, b) => serialize(b).length - serialize(a).length)[0];
    if (!entry) {
      const upload = result.results?.find(entry => entry.files?.length);
      if (!upload) break;
      upload.files.pop(); upload.omittedFiles = (upload.omittedFiles || 0) + 1;
      continue;
    }
    entry.rows.pop(); entry.omittedRows++; entry.truncated = true;
  }
  // `completed` has no per-item cost to trade away: a twelve-step batch is ~370
  // characters on its own, which alone can exceed a small budget. Collapse it to a
  // count rather than returning a receipt over the budget the caller configured.
  if (Array.isArray(result.completed) && result.completed.length) {
    while (serialize(result).length > budget && result.completed.length > 1) {
      result.completed.pop();
      result.completedTruncated = true;
    }
    if (serialize(result).length > budget) {
      result.completedCount = result.completed.length;
      result.completed = [];
      result.completedTruncated = true;
    }
  }
  return result;
}

export class BrowserEngine {
  constructor(bridge, { snapshotChars = 2400, artifactDir, captureRetention = false } = {}) {
    this.bridge = bridge;
    this.snapshotChars = snapshotChars;
    this.artifactDir = artifactDir;
    this.captureStore = captureRetention ? new CaptureStore(artifactDir) : undefined;
    this.states = new Map();
    this.queues = new Map();
    this.receipts = new Map();
    this.networks = new Map();
    this.actions = new Map();
    // A released relay invalidates the snapshot, but an uncertain-effect receipt
    // must survive it: it is the only evidence that a dispatched action may still
    // land, and dropping it would let the next call replay the effect.
    this.onRelease = ref => {
      this.states.delete(ref);
      if (!this.receipts.get(ref)?.mayHaveLateEffects) this.receipts.delete(ref);
      this.networks.get(ref)?.close();
      this.networks.delete(ref);
    };
    this.onActivityStop = (ref, reply) => {
      const controller = this.actions.get(ref);
      const stopped = !!controller && !controller.signal.aborted;
      if (stopped) controller.abort(new Error("Stopped from the DoYourWeb extension"));
      reply(stopped);
    };
    this.bridge.on?.("release", this.onRelease);
    this.bridge.on?.("activityStop", this.onActivityStop);
  }

  close() {
    this.bridge.off?.("release", this.onRelease);
    this.bridge.off?.("activityStop", this.onActivityStop);
    this.states.clear();
    this.receipts.clear();
    for (const capture of this.networks.values()) capture.close();
    this.networks.clear();
  }

  async withPage(ref, operation, signal, active = false, pageAccess) {
    checkpoint(signal);
    const controller = active && this.bridge.cdp ? new AbortController() : undefined;
    const actionSignal = controller ? signal ? AbortSignal.any([signal, controller.signal]) : controller.signal : signal;
    if (controller) this.actions.set(ref, controller);
    let activity;
    try {
      const page = await this.bridge.page(ref);
      checkpoint(actionSignal);
      pageAccess?.assertUrl(page.url());
      if (controller) activity = await browserActivity(this.bridge, ref).catch(() => {});
      const result = await operation(page, actionSignal);
      if (!active) pageAccess?.assertUrl(page.url());
      return result;
    } finally {
      if (controller) this.actions.delete(ref);
      await activity?.close();
      this.bridge.release?.(ref);
    }
  }

  async serial(ref, operation) {
    const previous = this.queues.get(ref) || Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    this.queues.set(ref, current);
    try { return await current; }
    finally { if (this.queues.get(ref) === current) this.queues.delete(ref); }
  }

  async document(page) {
    return page.evaluate(() => ({ url: location.href, epoch: performance.timeOrigin }));
  }

  async snapshot(ref, page, options = {}, signal) {
    checkpoint(signal);
    const before = await this.document(page);
    if (!canControl(before.url)) throw new Error("This tab navigated to an unsupported URL");
    // CSS locators pierce shadow roots, which may contain additional body nodes.
    let root = page.locator("xpath=/html/body");
    if (options.scope === "main") {
      const main = page.locator("main, [role='main']");
      if (await main.count() === 1 && await main.isVisible()) root = main;
    }
    if (options.selector) root = page.locator(options.selector);
    if (options.query) root = root.getByText(options.query, { exact: false });
    let text;
    try {
      text = await root.ariaSnapshot({ mode: "ai", depth: options.depth || 8, timeout: 8000, signal });
    } catch (error) {
      if (!error.message?.includes("strict mode violation")) throw error;
      throw new Error("Read scope matches multiple elements. Choose one unique root (for example their common parent), or read each scope separately. Comma selectors are supported when they resolve to one element.", { cause: error });
    }
    const after = await this.document(page);
    checkpoint(signal);
    if (before.epoch !== after.epoch || before.url !== after.url) throw new Error("Page navigated while reading; read it again");
    const state = { id: randomUUID().slice(0, 8), text, ...after, title: await page.title(), ref };
    this.states.set(ref, state);
    return state;
  }

  async read(ref, options = {}, signal) {
    return this.serial(ref, () => this.withPage(ref, async page => {
      checkpoint(signal);
      const limit = Math.max(400, Math.min(8000, options.limit || this.snapshotChars));
      if (options.cursor) {
        const [id, offset] = options.cursor.split(":");
        const state = this.states.get(ref);
        const document = await this.document(page);
        if (!state || state.id !== id || document.epoch !== state.epoch || document.url !== state.url) {
          throw new Error("Snapshot cursor is stale; read the page again without cursor");
        }
        checkpoint(signal);
        const chunk = boundedChunk(state, Number(offset), limit, { tab: ref,
          ...(this.receipts.has(ref) ? { lastAction: this.receipts.get(ref) } : {}) });
        state.refsAvailable = true;
        return chunk;
      }
      const state = await this.snapshot(ref, page, options, signal);
      checkpoint(signal);
      return boundedChunk(state, 0, limit, { tab: ref,
        ...(this.receipts.has(ref) ? { lastAction: this.receipts.get(ref) } : {}) });
    }, signal, false, options.pageAccess));
  }

  locator(page, step) {
    if (step.ref) {
      if (!/^(?:f\d+)?e\d+$/.test(step.ref)) throw new Error("Use an element ref from the latest browser_read snapshot");
      return page.locator(`aria-ref=${step.ref}`);
    }
    if (step.selector) return step.frame ? page.frameLocator(step.frame).locator(step.selector) : page.locator(step.selector);
    throw new Error("Action requires ref or selector");
  }

  async act(ref, options, signal) {
    return this.serial(ref, () => this.withPage(ref, async (page, actionSignal) => {
      signal = actionSignal;
      checkpoint(signal);
      const state = this.states.get(ref);
      const actionId = randomUUID().slice(0, 8);
      const uploads = new Map();
      let document = await this.document(page);
      const pageAccess = options.pageAccess;
      try {
        pageAccess?.assertUrl(document.url);
        if (!state || options.snapshot !== state.id || document.epoch !== state.epoch || document.url !== state.url) {
          throw new Error("Snapshot is stale. Use the latest DOM snapshot for this tab; a new read without cursor replaces it, while cursor pages and reads of other tabs do not. Call browser_read before acting; no actions were performed.");
        }
        if (state.refsAvailable === false && options.steps.some(step => step.ref || step.toRef)) throw new Error("Handle receipt withheld element refs. Read its cursor before using refs, or continue with selectors; old refs must not be reused.");
        for (const step of options.steps) if (step.op === "navigate") {
          if (!step.value?.trim()) throw new Error('navigate requires a URL in step.value, for example {"op":"navigate","value":"https://example.com"}; url and target are not supported. No actions were performed.');
          if (!canControl(step.value)) throw new Error("navigate step.value must be an HTTP/HTTPS or local file URL. No actions were performed.");
          pageAccess?.assertUrl(step.value);
        }
        for (const [index, step] of options.steps.entries()) if (step.op === "upload" || step.op === "drop" && step.files) {
          if (!Array.isArray(step.files) || !step.files.length || step.files.length > 20) throw new Error("Upload requires 1-20 explicitly authorized absolute file paths");
          const files = [];
          for (const file of step.files) {
            if (typeof file !== "string" || !path.isAbsolute(file)) throw new Error("Upload paths must be absolute local files");
            const resolved = await realpath(file);
            if (!(await stat(resolved)).isFile()) throw new Error("Upload requires a regular file, not a directory");
            await access(resolved, constants.R_OK); files.push(resolved);
          }
          uploads.set(index, files);
        }
      } catch (error) {
        // A rejected retry must never destroy the evidence of a batch that may have
        // dispatched something. A preflight failure dispatches nothing, so it may
        // only replace a receipt that also records no dispatch; otherwise the model
        // would be told "nothing was dispatched" and could replay an action that
        // already landed, or lose the completed steps of a cancelled batch.
        const existing = this.receipts.get(ref);
        const dispatched = !!existing && (existing.mayHaveLateEffects === true
          || existing.cancelled === true
          || (Array.isArray(existing.completed) && existing.completed.length > 0)
          || (existing.failure !== undefined && existing.failure.dispatch !== "none"));
        if (!dispatched) this.receipts.set(ref,
          { actionId, snapshot: options.snapshot, completed: [], dispatch: "none", rejected: true });
        throw error;
      }
      const completed = [];
      const results = [];
      const extractCount = options.steps.filter(step => step.op === "extract").length;
      const extractLimit = Math.max(64, Math.floor(600 / Math.max(1, extractCount)));
      let failure;
      let navigated = false;
      let cancelled = false;
      let uncertainStep;
      // Invalidate before dispatch: cancellation must not leave an old snapshot reusable.
      this.states.delete(ref);
      this.receipts.delete(ref);
      for (let index = 0; index < options.steps.length; index++) {
        const step = options.steps[index];
        let invoked = false, sent = false, phase;
        const invoke = operation => { invoked = true; return operation(); };
        const commandSent = (tab, command) => {
          if (invoked && tab === ref && /^(?:Input\.(?:dispatchMouseEvent|dispatchKeyEvent|insertText|dispatchTouchEvent|dispatchDragEvent)|DOM\.setFileInputFiles|Page\.(?:navigate|navigateToHistoryEntry))$/.test(command)) sent = true;
        };
        this.bridge.on?.("commandSent", commandSent);
        try {
          checkpoint(signal);
          pageAccess?.assertUrl(page.url());
          if (step.op === "navigate") {
            await invoke(() => page.goto(step.value, { waitUntil: "domcontentloaded", signal }));
          } else if (step.op === "back") await invoke(() => page.goBack({ waitUntil: "domcontentloaded", signal }));
          else if (step.op === "forward") await invoke(() => page.goForward({ waitUntil: "domcontentloaded", signal }));
          else if (step.op === "scroll") {
            await invoke(() => page.mouse.wheel(0, step.amount || 600));
          } else {
            const target = this.locator(page, step);
            if (step.op === "click") await invoke(() => target.click({ signal }));
            else if (step.op === "drag") {
              const destination = this.locator(page, { ref: step.toRef, selector: step.toSelector, frame: step.frame });
              await invoke(() => target.dragTo(destination, { timeout: 8000, signal }));
            }
            else if (step.op === "drop") {
              await invoke(() => target.drop({ ...(uploads.has(index) ? { files: uploads.get(index) } : {}), ...(step.data ? { data: step.data } : {}) }, { timeout: 8000, signal }));
              if (uploads.has(index)) results.push({ index, files: uploads.get(index).map(file => clip(path.basename(file), 40)) });
            }
            else if (step.op === "upload") {
              const files = uploads.get(index);
              const input = await target.evaluate(element => element.localName === "input" && element.type === "file", undefined, { timeout: 8000, signal });
              phase = input ? "selecting_files" : "opening_chooser";
              if (input) await invoke(() => target.setInputFiles(files, { timeout: 8000, signal }));
              else {
                // Cancel the waiter when its triggering click fails as well.
                const chooserController = new AbortController();
                const chooserSignal = signal ? AbortSignal.any([signal, chooserController.signal]) : chooserController.signal;
                const pending = page.waitForEvent("filechooser", { timeout: 8000, signal: chooserSignal });
                pending.catch(() => {});
                try {
                  await invoke(() => target.click({ timeout: 8000, signal }));
                  phase = "button_clicked";
                  const chooser = await pending;
                  phase = "chooser_received";
                  checkpoint(signal);
                  await chooser.setFiles(files, { timeout: 8000, signal });
                } finally { chooserController.abort(); }
              }
              phase = "files_selected";
              results.push({ index, files: files.map(file => clip(path.basename(file), 40)) });
            }
            else if (step.op === "fill") await invoke(() => target.fill(step.value, { signal }));
            else if (step.op === "press") await invoke(() => target.press(step.value, { signal }));
            else if (step.op === "select") await invoke(() => target.selectOption(step.value, { signal }));
            else if (step.op === "check") await invoke(() => target.setChecked(step.checked ?? true, { signal }));
            else if (step.op === "hover") await invoke(() => target.hover({ signal }));
            else if (step.op === "wait") await target.waitFor({ state: step.state || "visible", timeout: step.timeout || 8000, signal });
            else if (step.op === "extract") {
              const fields = step.fields || ["text"];
              if (!fields.length || fields.some(field => !["text", "value", "href"].includes(field))) {
                throw new Error("Extract fields must be text, value or href");
              }
              const data = await target.evaluateAll((nodes, { fields, maxRows }) => {
                let truncated = false;
                const rows = nodes.slice(0, maxRows).map(node => {
                  const row = {};
                  for (const field of fields) {
                    const value = field === "text" ? (node.innerText ?? node.textContent ?? "").replace(/\s+/g, " ").trim()
                      : field === "href" ? (node.href ?? "")
                        : node.type === "password" ? "" : (node.value ?? "");
                    const text = String(value);
                    if (text.length > 200) truncated = true;
                    row[field] = text.slice(0, 200);
                  }
                  return row;
                });
                return { rows, totalRows: nodes.length, truncated };
              }, { fields, maxRows: Math.max(1, Math.min(20, step.maxRows || 10)) });
              results.push(boundedExtraction(index, data, extractLimit));
            }
            else throw new Error(`Unknown action: ${step.op}`);
          }
          completed.push({ index, op: step.op });
          checkpoint(signal);
          const after = await this.document(page);
          pageAccess?.assertUrl(after.url);
          if (after.epoch !== document.epoch || after.url !== document.url) {
            const previous = new URL(document.url), current = new URL(after.url);
            const soft = after.epoch === document.epoch && current.origin === previous.origin && current.pathname === previous.pathname;
            // A query/hash update does not prove DOM refs are still valid.
            // Only selector-based observations or target-free navigation/scroll
            // can follow; a selector alone cannot prove a changed form is safe.
            if (soft && options.steps.slice(index + 1).every(next => !next.ref && ["wait", "extract", "scroll", "navigate", "back", "forward"].includes(next.op))) { document = after; }
            else { navigated = true; break; }
          }
        } catch (error) {
          cancelled = signal?.aborted === true;
          if (invoked && completed.at(-1)?.index !== index) uncertainStep = index;
          failure = { index, op: step.op, error: clip(error.message || error, 200),
            dispatch: sent ? "sent" : invoked ? "unknown" : "none", ...(phase ? { phase } : {}) };
          break;
        } finally { this.bridge.off?.("commandSent", commandSent); }
      }
      const budget = Math.max(400, Math.min(8000, this.snapshotChars));
      const result = boundAction({ tab: ref, actionId, fromSnapshot: state.id, completed, remaining: options.steps.length - completed.length,
        ...(results.length ? { results } : {}),
        ...(failure ? { failure, retry: "Read current state first. Do not replay completed or uncertain actions." } : {}),
        ...(navigated ? { navigated: true, stopped: "Navigation occurred; read the new page before remaining actions." } : {}),
        ...(cancelled ? { cancelled: true } : {}),
        ...(uncertainStep !== undefined ? { uncertainStep, mayHaveLateEffects: true } : {}) }, budget);
      const receipt = { actionId, snapshot: state.id, completed: completed.map(step => step.index),
        ...(failure ? { failure: { index: failure.index, dispatch: failure.dispatch, ...(failure.phase ? { phase: failure.phase } : {}) } } : {}),
        ...(cancelled ? { cancelled: true } : {}),
        ...(navigated ? { navigated: true } : {}),
        ...(uncertainStep !== undefined ? { uncertainStep, mayHaveLateEffects: true } : {}) };
      this.receipts.set(ref, receipt);
      if (cancelled) return result;
      if (options.expect && !failure && completed.length === options.steps.length) {
        const expected = options.expect;
        const wait = { timeout: expected.timeout || 8000, signal };
        try {
          checkpoint(signal);
          pageAccess?.assertUrl(page.url());
          if (expected.kind === "url") await page.waitForURL(url => url.href === expected.value, { ...wait, waitUntil: "commit" });
          else {
            const target = this.locator(page, expected);
            if (expected.kind === "visible") await target.waitFor({ state: "visible", ...wait });
            else await target.waitForFunction((element, expected) => expected.kind === "text"
              ? (element.innerText ?? element.textContent ?? "").includes(expected.value)
              : element.type !== "password" && element.value === expected.value,
            { kind: expected.kind, value: expected.value }, wait);
          }
          checkpoint(signal);
          pageAccess?.assertUrl(page.url());
          result.expectation = { kind: expected.kind, status: "matched" };
        } catch (error) {
          result.expectation = { kind: expected.kind, status: signal?.aborted ? "cancelled" : error.name === "TimeoutError" ? "unmet" : "error", error: clip(error.message || error, 200) };
          if (signal?.aborted) { result.cancelled = true; receipt.cancelled = true; }
        }
        receipt.expectation = { kind: result.expectation.kind, status: result.expectation.status };
      }
      if (result.cancelled) return boundAction(result, budget);
      if (options.observe === "summary") return boundAction(result, budget);
      try {
        pageAccess?.assertUrl(page.url());
        const next = await this.snapshot(ref, page, options.observation || {}, signal);
        pageAccess?.assertUrl(next.url);
        if (options.observe === "handle") {
          next.refsAvailable = false;
          return boundAction({ ...result, snapshot: next.id, cursor: `${next.id}:0`, url: clip(next.url, 512), title: clip(next.title, 128), refs: "read_required" }, budget);
        }
        return boundedChunk(next, 0, budget, result);
      } catch (error) {
        if (signal?.aborted) {
          this.states.delete(ref);
          receipt.cancelled = true;
          return { ...result, cancelled: true };
        }
        receipt.readError = true;
        return boundAction({ ...result, ...(!pageAccess ? { url: clip(page.url(), 256) } : {}), readError: clip(error.message, 200) }, budget);
      }
    }, signal, true, options.pageAccess));
  }

  upload(ref, options, signal) {
    return this.act(ref, { snapshot: options.snapshot, observe: options.observe, observation: options.observation, expect: options.expect, pageAccess: options.pageAccess,
      steps: [{ op: "upload", ref: options.ref, selector: options.selector, frame: options.frame, files: options.files }] }, signal);
  }

  async network(ref, options = {}, signal) {
    return this.serial(ref, () => this.withPage(ref, async page => {
      checkpoint(signal);
      let capture = this.networks.get(ref);
      if (options.action === "start" && !capture?.active) {
        capture?.close();
        capture = new NetworkCapture(page, options.pageAccess?.signal);
        this.networks.set(ref, capture);
      }
      if (!capture) return { tab: ref, capturing: false, capturingSince: null, requests: [], note: "Not recording. Use action:start before the activity; past requests cannot be recovered." };
      if (options.action === "stop") capture.close();
      if (options.action === "clear") capture.clear();
      return { tab: ref, ...capture.result(options) };
    }, signal, false, options.pageAccess));
  }

  async capture(ref, options = {}, signal) {
    return this.serial(ref, () => this.withPage(ref, async page => {
      checkpoint(signal);
      await mkdir(this.artifactDir, { recursive: true });
      const output = path.join(this.artifactDir, `dsh-capture-${randomUUID()}.png`);
      const bytes = await page.screenshot({ path: options.pageAccess ? undefined : output, fullPage: options.fullPage === true, animations: "disabled", signal });
      options.pageAccess?.assertUrl(page.url());
      if (options.pageAccess) await writeFile(output, bytes);
      await this.captureStore?.record(output);
      checkpoint(signal);
      return { tab: ref, url: clip(page.url(), 512), path: output, mediaType: "image/png" };
    }, signal, false, options.pageAccess));
  }
}
