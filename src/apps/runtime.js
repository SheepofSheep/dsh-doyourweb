import spawn from "cross-spawn";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import Ajv from "ajv";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { clip } from "../output.js";
import { driverData, controlPage } from "./desktop.js";

export class UncertainOperation extends Error {
  constructor(message, cause) { super(message, { cause }); this.mayHaveEffects = true; }
}

export function runProcess(command, args = [], { cwd, env, signal, timeout = 30000, maxChars = 12000 } = {}) {
  if (signal?.aborted) return Promise.reject(signal.reason || new Error("Cancelled"));
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: { ...getDefaultEnvironment(), ...env }, windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", truncated = false, failed;
    const append = key => chunk => {
      const text = chunk.toString("utf8");
      const remaining = Math.max(0, maxChars - (key === "stdout" ? stdout.length : stderr.length));
      truncated ||= text.length > remaining;
      if (key === "stdout") stdout += text.slice(0, remaining);
      else stderr += text.slice(0, remaining);
    };
    child.stdout?.on("data", append("stdout")); child.stderr?.on("data", append("stderr"));
    const cancel = reason => { failed ||= new UncertainOperation(reason); child.kill(); cleanup(); reject(failed); };
    const abort = () => cancel("Command cancelled after dispatch; inspect the application before retrying or changing channels");
    const timer = setTimeout(() => cancel("Command timed out after dispatch; inspect the application before retrying or changing channels"), timeout);
    timer.unref(); signal?.addEventListener("abort", abort, { once: true });
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); };
    child.once("error", error => { cleanup(); reject(error); });
    child.once("close", code => {
      cleanup();
      if (failed) { reject(failed); return; }
      const outChars = Math.min(stdout.length, maxChars - Math.min(stderr.length, Math.floor(maxChars / 2)));
      const errChars = Math.min(stderr.length, maxChars - outChars);
      resolve({ exitCode: code, stdout: stdout.slice(0, outChars), stderr: stderr.slice(0, errChars),
        truncated: truncated || stdout.length + stderr.length > maxChars });
    });
    if (signal?.aborted) abort();
  });
}

export class McpConnection {
  constructor(candidate) { this.candidate = candidate; this.tools = new Map(); this.validators = new Map(); this.client = new Client({ name: "dsh-doyourweb", version: "0.1.9" }); }
  async connect(signal) {
    const c = this.candidate;
    if (c.url) this.transport = new StreamableHTTPClientTransport(new URL(c.url), { requestInit: { headers: c.headers || {}, redirect: "error" } });
    else this.transport = new StdioClientTransport({ command: c.command, args: c.args || [], cwd: c.cwd,
      env: { ...getDefaultEnvironment(), ...c.env }, stderr: "pipe", maxBufferSize: 8 * 1024 * 1024 });
    this.transport.stderr?.on("data", () => {});
    try {
      await this.client.connect(this.transport, { signal, timeout: 15000 });
      await this.refresh(signal); return this;
    } catch (error) { await this.close(); throw error; }
  }
  async refresh(signal) {
    const next = new Map(); let cursor;
    for (let count = 0; count < 20; count++) {
      const result = await this.client.listTools(cursor ? { cursor } : undefined, { signal, timeout: 15000 });
      for (const item of result.tools) { if (next.has(item.name)) throw new Error("MCP server returned duplicate tool names"); next.set(item.name, item); }
      cursor = result.nextCursor; if (!cursor) break;
      if (count === 19) throw new Error("MCP tool catalog is too large");
    }
    this.tools = next; this.validators.clear();
  }
  catalog(query = "") {
    const q = query.toLowerCase();
    let budget = 10000;
    return [...this.tools.values()].filter(item => !q || `${item.name} ${item.description || ""}`.toLowerCase().includes(q)).slice(0, 8)
      .map(item => {
        const value = { name: item.name, description: clip(item.description || "", 300), inputSchema: item.inputSchema, annotations: item.annotations };
        const size = JSON.stringify(value).length;
        if (size > budget) return { name: item.name, schemaOmitted: true, reason: "Schema exceeds remaining output budget; narrow query. Schemas over 10,000 characters need a smaller server tool definition." };
        budget -= size; return value;
      });
  }
  validate(name, args = {}) {
    const definition = this.tools.get(name); if (!definition) throw new Error("Tool is not in the connected MCP catalog");
    let validate = this.validators.get(name);
    if (!validate) { validate = new Ajv({ strict: false, validateFormats: false, ownProperties: true }).compile(definition.inputSchema); this.validators.set(name, validate); }
    if (!validate(args)) throw new Error(`Invalid MCP arguments: ${JSON.stringify(validate.errors)}`);
  }
  async call(name, args = {}, { signal, timeout = 30000 } = {}) {
    this.validate(name, args);
    try { return await this.client.callTool({ name, arguments: args }, undefined, { signal, timeout }); }
    catch (error) { throw new UncertainOperation("MCP call failed after dispatch; inspect current state before repeating or using another channel", error); }
  }
  async close() { await this.client.close().catch(() => {}); }
}

export async function projectMcpResult(result, captures, limit = 8000) {
  const output = { isError: !!result.isError, content: [], untrusted: true };
  const data = driverData(result);
  const hasControls = Array.isArray(data.elements) || typeof data.snapshot_id === "string";
  const projected = hasControls ? { ...controlPage(data, 0, Math.max(400, Math.floor(limit * .65))),
    window_bounds: data.window_bounds, screenshot_width: data.screenshot_width, screenshot_height: data.screenshot_height,
    degraded: data.degraded, degraded_reason: data.degraded_reason, capture_coverage: data.capture_coverage } : result.structuredContent;
  const structured = projected === undefined ? undefined : JSON.stringify(projected);
  let remaining = limit;
  if (!hasControls && typeof data.effect === "string") {
    output.action = Object.fromEntries(["effect", "route", "delivery", "escalation", "evidence"].filter(k => data[k] !== undefined).map(k => [k, data[k]]));
  }
  if (hasControls) {
    output.state = projected;
    remaining = Math.max(0, remaining - structured.length);
  }
  for (const block of (result.content || []).slice(0, 20)) {
    if (block.type === "text") {
      if (structured !== undefined) {
        try { if (isDeepStrictEqual(JSON.parse(block.text), hasControls ? data : result.structuredContent)) continue; }
        catch { /* Distinct commentary remains part of the result. */ }
      }
      const text = clip(block.text || "", Math.max(0, remaining));
      if (text) output.content.push({ type: "text", text });
      remaining -= text.length;
    } else if (block.type === "image" && ["image/png", "image/jpeg", "image/webp"].includes(block.mimeType)) {
      if (typeof block.data !== "string" || block.data.length > 16 * 1024 * 1024) throw new Error("MCP screenshot exceeds image size limit");
      await mkdir(captures, { recursive: true });
      const file = path.join(captures, `${randomUUID()}.${block.mimeType === "image/png" ? "png" : block.mimeType === "image/jpeg" ? "jpg" : "webp"}`);
      await writeFile(file, Buffer.from(block.data, "base64"), { mode: 0o600 });
      output.content.push({ type: "image", path: file, mimeType: block.mimeType });
    } else if (block.type === "resource_link") output.content.push({ type: "resource", name: clip(block.name || "", 100), uri: clip(block.uri || "", 1000) });
  }
  if (structured !== undefined && !hasControls) output.structured = clip(structured, Math.max(0, remaining));
  return output;
}
