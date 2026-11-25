import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import Ajv from "ajv";
import Ajv2020 from "ajv/dist/2020.js";
import { clip, serialize } from "./output.js";

const validationOptions = { strict: false, validateFormats: false, ownProperties: true };

function bounded(result, limit) {
  if (serialize(result).length <= limit) return result;
  result.truncated = true;
  const key = typeof result.result === "string" ? "result" : "error";
  const original = result[key] || "";
  let low = 0, high = original.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    result[key] = clip(original, middle);
    if (serialize(result).length <= limit) low = middle; else high = middle - 1;
  }
  result[key] = clip(original, low);
  return result;
}

// Keep RegisteredTool objects in their document: their Window cannot be serialized.
async function discover(query) {
  const context = document.modelContext;
  if (!context || typeof context.getTools !== "function" || typeof context.executeTool !== "function") {
    return { supported: false };
  }
  const state = { supported: true, context, changed: false };
  state.listener = () => { state.changed = true; };
  context.addEventListener("toolchange", state.listener);
  try {
    const tools = (await context.getTools()).filter(tool => tool.window === window && tool.origin === location.origin)
      .filter(tool => !query || `${tool.name} ${tool.description}`.toLowerCase().includes(query));
    state.total = tools.length;
    state.tools = tools.slice(0, 8);
    return state;
  } catch (error) {
    context.removeEventListener("toolchange", state.listener);
    throw error;
  }
}

async function dispose(handle) {
  await handle.evaluate(state => {
    state.controller?.abort();
    state.context?.removeEventListener("toolchange", state.listener);
  }).catch(() => {});
  await handle.dispose().catch(() => {});
}

export class WebMCP {
  constructor(engine) {
    this.engine = engine;
    this.catalogs = new Map();
    this.onRelease = ref => { void this.drop(ref); };
    engine.bridge.on?.("release", this.onRelease);
  }

  async drop(ref) {
    const state = this.catalogs.get(ref);
    if (!state) return;
    this.catalogs.delete(ref);
    await dispose(state.handle);
  }

  async close() {
    this.engine.bridge.off?.("release", this.onRelease);
    await Promise.all([...this.catalogs.keys()].map(ref => this.drop(ref)));
  }

  async read(ref, options = {}, signal) {
    if (options.mode === "dom" || options.cursor || this.engine.receipts.get(ref)?.mayHaveLateEffects) {
      return this.engine.read(ref, options, signal);
    }
    const catalog = await this.list(ref, { limit: options.limit || this.engine.snapshotChars, pageAccess: options.pageAccess }, signal);
    if (catalog.omitted > 0 || catalog.tools.some(tool => tool.available && !tool.annotations?.consequentialHint)) {
      return catalog;
    }
    return this.engine.read(ref, options, signal);
  }

  catalogResult(ref, state, limit) {
    if (!state.supported) return { tab: ref, supported: false, tools: [],
      fallback: "Use browser_read with mode:dom or browser_act; no compatible document.modelContext API." };
    const tools = [...state.tools];
    const result = { tab: ref, supported: true, catalog: state.catalog, tools,
      omitted: state.total - tools.length, untrusted: true };
    while (tools.length && serialize(result).length > limit) { tools.pop(); result.omitted++; }
    state.names = new Set(tools.map(tool => tool.name));
    return result;
  }

  async list(ref, options = {}, signal) {
    return this.engine.serial(ref, () => this.engine.withPage(ref, async page => {
      signal?.throwIfAborted();
      const document = await this.engine.document(page);
      const query = (options.query || "").toLowerCase();
      const limit = Math.max(400, Math.min(8000, options.limit || 4000));
      const cached = this.catalogs.get(ref);
      if (cached && !cached.consumed && cached.query === query
        && cached.document.epoch === document.epoch && cached.document.url === document.url
        && !await cached.handle.evaluate(state => state.changed === true)) {
        signal?.throwIfAborted();
        return this.catalogResult(ref, cached, limit);
      }
      await this.drop(ref);
      const handle = await page.evaluateHandle(discover, query);
      try {
        const metadata = await handle.evaluate(state => ({ supported: state.supported, total: state.total,
          tools: state.tools?.map(tool => {
            const inputSchema = tool.inputSchema ?? { type: "object" };
            const fits = JSON.stringify(inputSchema).length <= 4000;
            return { name: tool.name, description: tool.description.slice(0, 400),
              inputSchema: fits ? inputSchema : undefined,
              schemaError: fits ? undefined : "Input schema exceeds the experiment's 4000-character limit",
              annotations: { readOnlyHint: tool.annotations?.readOnlyHint === true,
                consequentialHint: tool.annotations?.consequentialHint === true,
                untrustedContentHint: tool.annotations?.untrustedContentHint === true } };
          }) }));
        signal?.throwIfAborted();
        const after = await this.engine.document(page);
        if (after.epoch !== document.epoch || after.url !== document.url) throw new Error("Page navigated during WebMCP discovery; list again");
        const validators = new Map();
        const tools = (metadata.tools || []).map(tool => {
          try {
            if (tool.schemaError) throw new Error(tool.schemaError);
            const Validator = tool.inputSchema.$schema?.includes("2020-12") ? Ajv2020 : Ajv;
            validators.set(tool.name, new Validator(validationOptions).compile(tool.inputSchema));
            return { ...tool, available: true };
          } catch (error) {
            return { name: tool.name, available: false, error: clip(`Invalid or unsupported input schema: ${error.message}`, 200) };
          }
        });
        const state = { handle, catalog: randomUUID(), document, validators, query,
          supported: metadata.supported, total: metadata.total || 0, tools, consumed: false };
        this.catalogs.set(ref, state);
        return this.catalogResult(ref, state, limit);
      } catch (error) {
        await dispose(handle);
        throw error;
      }
    }, signal, false, options.pageAccess));
  }

  async call(ref, options, signal) {
    return this.engine.serial(ref, () => this.engine.withPage(ref, async page => {
      signal?.throwIfAborted();
      const state = this.catalogs.get(ref);
      if (!state || state.consumed || state.catalog !== options.catalog) throw new Error("WebMCP catalog is missing or expired; call browser_webmcp_list again");
      if (!state.names.has(options.name)) throw new Error("Tool was not included in this catalog; narrow browser_webmcp_list with query");
      const validate = state.validators.get(options.name);
      if (!validate) throw new Error("Tool input schema is unsupported; use the regular browser tools");
      const input = options.arguments ?? {};
      if (serialize(input).length > 8000) throw new Error("WebMCP arguments exceed 8000 characters");
      if (!validate(input)) throw new Error(`Invalid WebMCP arguments: ${clip(JSON.stringify(validate.errors), 300)}`);
      const current = await this.engine.document(page);
      if (current.epoch !== state.document.epoch || current.url !== state.document.url) {
        await this.drop(ref);
        throw new Error("WebMCP catalog is stale after navigation; list again");
      }
      const safety = await state.handle.evaluate((browserState, name) => ({ changed: browserState.changed,
        consequential: browserState.tools.find(tool => tool.name === name)?.annotations?.consequentialHint === true,
      }), options.name);
      if (safety.changed) { await this.drop(ref); throw new Error("WebMCP tools changed; list again"); }
      if (safety.consequential) throw new Error("Consequential WebMCP tools are disabled in this experiment; complete the action manually");
      signal?.throwIfAborted();
      state.consumed = true;
      this.engine.states.delete(ref);
      this.engine.receipts.delete(ref);
      const base = { catalog: state.catalog, name: options.name, untrusted: true };
      const limit = Math.max(400, Math.min(8000, options.limit || 2400));
      const uncertain = (status, error) => {
        this.engine.receipts.set(ref, { kind: "webmcp", name: options.name, mayHaveLateEffects: true });
        return bounded({ ...base, status, error: clip(error, 300), mayHaveLateEffects: true,
          retry: "Inspect with browser_read mode:dom before retrying; the tool may already have run." }, limit);
      };
      try {
        // Start without awaiting the site's promise: the bridge has a shorter RPC
        // timeout. Poll locally so long tools do not require extra model turns.
        await state.handle.evaluate((browserState, { name, input }) => {
          browserState.controller = new AbortController();
          browserState.status = "running";
          Promise.resolve().then(() => {
            if (browserState.changed) throw new Error("WebMCP tools changed before dispatch; list again");
            const tool = browserState.tools.find(tool => tool.name === name);
            if (tool.annotations?.consequentialHint) throw new Error("Consequential WebMCP tool is disabled");
            return browserState.context.executeTool(tool, input, { signal: browserState.controller.signal });
          }).then(result => {
            browserState.result = typeof result === "string" ? result : JSON.stringify(result);
            browserState.status = "completed";
          }, error => { browserState.error = String(error).slice(0, 300); browserState.status = "error"; });
        }, { name: options.name, input });
        const deadline = Date.now() + Math.max(1, Math.min(120000, options.timeout || 15000));
        while (true) {
          signal?.throwIfAborted();
          const result = await state.handle.evaluate((browserState, size) => ({ status: browserState.status,
            result: browserState.result?.slice(0, size), totalChars: browserState.result?.length, error: browserState.error,
          }), limit);
          if (result.status === "completed") {
            const current = await this.engine.document(page);
            const changed = await state.handle.evaluate(browserState => browserState.changed);
            // Rotate the consumed token, not the schemas: completed calls can chain
            // without another model discovery turn while old tokens stay invalid.
            if (!changed && current.epoch === state.document.epoch && current.url === state.document.url) {
              state.catalog = randomUUID();
              state.consumed = false;
            }
            return bounded({ ...base, ...result,
              ...(!state.consumed ? { nextCatalog: state.catalog } : {}),
              ...(result.totalChars > limit ? { truncated: true } : {}) }, limit);
          }
          if (result.status === "error") return uncertain("error", result.error);
          if (Date.now() >= deadline) return uncertain("timeout", "WebMCP tool exceeded its timeout; cancellation requested");
          await delay(Math.min(100, deadline - Date.now()), undefined, { signal });
        }
      } catch (error) {
        return uncertain(signal?.aborted ? "cancelled" : "error", error.message || error);
      } finally {
        if (state.consumed) await this.drop(ref);
      }
    }, signal, false, options.pageAccess));
  }
}
