import { clip } from "./output.js";

export const SCHEME = "dsh-browser://";
export const PACKAGE = "dsh-doyourweb";

export function tabRef(profile, tabId) {
  if (!/^[a-z0-9-]{1,80}$/i.test(profile) || !Number.isSafeInteger(tabId) || tabId < 0) {
    throw new Error("Invalid browser tab identity");
  }
  return `${SCHEME}${profile}/${tabId}`;
}

export function parseRef(value) {
  const match = /^dsh-browser:\/\/([a-z0-9-]{1,80})\/(\d+)$/i.exec(value);
  if (!match || !Number.isSafeInteger(Number(match[2]))) throw new Error("Invalid browser tab reference");
  return { profile: match[1], tabId: Number(match[2]) };
}

export function mentions(text) {
  return [...new Set(text.match(/dsh-browser:\/\/[a-z0-9-]{1,80}\/\d+/gi) ?? [])];
}

export function formatMention(tab) {
  const title = clip(String(tab.title || "Browser tab").replace(/[\[\]\\\r\n]/g, " "), 128);
  return `@[${title}](${tab.ref})`;
}

export function canControl(url) {
  try { return ["https:", "http:", "file:"].includes(new URL(url).protocol); } catch { return false; }
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const FIELD_KINDS = {
  string: { test: value => typeof value === "string", describe: "a string" },
  boolean: { test: value => typeof value === "boolean", describe: "a boolean" },
  array: { test: value => Array.isArray(value), describe: "an array" },
  object: { test: isPlainObject, describe: "a plain object" },
  number: { test: value => Number.isSafeInteger(value) && value >= 0, describe: "a nonnegative integer" },
};

/** Boundary validation for one wire object: unknown fields and mistyped fields are rejected. */
function parseFields(value, fields, subject) {
  if (!isPlainObject(value)) throw new TypeError(`${subject} must be a plain object`);
  for (const key of Object.keys(value)) {
    if (!Object.hasOwn(fields, key)) throw new TypeError(`${subject} has an unexpected field ${JSON.stringify(key)}`);
  }
  const parsed = {};
  for (const [key, kind] of Object.entries(fields)) {
    const item = value[key];
    if (item === undefined) continue;
    if (!FIELD_KINDS[kind].test(item)) throw new TypeError(`${subject} field ${JSON.stringify(key)} must be ${FIELD_KINDS[kind].describe}`);
    parsed[key] = item;
  }
  return parsed;
}

/**
 * A Typert strict codec. DSH's Client Remote gateway refuses to mount a
 * contribution unless every parameter carries `mode: "strict"` with a type
 * symbol and a `create()` schema factory; the host gateway validates incoming
 * wire values with `create().parse(value)`. `src-json` markers are accepted by
 * the host registry but silently break the client mount.
 */
function strictCodec(name, parse) {
  let schema;
  return {
    mode: "strict",
    typeSymbol: `${PACKAGE}#${name}`,
    create: () => (schema ??= { parse }),
  };
}

function request(name, fields) {
  return [{ name: "request", wire: "request", source: "json", acceptsUndefined: true,
    codec: strictCodec(`${name}:request`, value => parseFields(value, fields, `${name} request`)) }];
}

function result(name, fields) {
  return strictCodec(`${name}:result`, value => parseFields(value, fields, `${name} result`));
}

const invocations = [
  { method: "list", parameters: request("browserTabs/list", { query: "string" }),
    result: result("browserTabs/list", { tabs: "array", connected: "boolean" }) },
  { method: "setup", parameters: request("browserTabs/setup", {}),
    result: result("browserTabs/setup", { url: "string", extensionPath: "string" }) },
  { method: "focus", parameters: request("browserTabs/focus", { ref: "string" }),
    result: result("browserTabs/focus", { ok: "boolean" }) },
  { method: "apps", parameters: request("browserTabs/apps", { query: "string" }),
    result: result("browserTabs/apps", { apps: "array", error: "string" }) },
  { method: "annotationSession", parameters: request("browserTabs/annotationSession", { client: "string", revision: "number", sessionId: "string", title: "string", active: "boolean", acknowledgements: "array" }),
    result: result("browserTabs/annotationSession", { ok: "boolean", drafts: "array" }) },
  { method: "manage", parameters: request("browserTabs/manage", {}),
    result: result("browserTabs/manage", { url: "string" }) },
  { method: "diagnostics", parameters: request("browserTabs/diagnostics", { clear: "boolean", enabled: "boolean" }),
    result: result("browserTabs/diagnostics", { enabled: "boolean", capacity: "number", events: "array", version: "string" }) },
];

export const descriptors = invocations.map(({ method, parameters, result: codec }) => ({
  id: `${PACKAGE}#browserTabs/${method}`,
  service: "browserTabs", namespace: "browserTabs", method,
  invocation: { kind: "direct" },
  parameters,
  cancellation: { parameter: "signal" },
  result: codec,
}));

export const remoteContribution = { package: PACKAGE, descriptors };
export const hostContribution = {
  package: PACKAGE, face: "host", schemas: [], invocations: descriptors,
  model: { services: [], events: [], objects: [] },
};
