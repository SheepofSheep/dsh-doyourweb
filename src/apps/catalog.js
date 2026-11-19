import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { findExecutable } from "./processes.js";

export const CATALOG = [
  { id: "unity-cli", match: /^(unity|unity hub)$/i, label: "Unity CLI", publisher: "unity.com", provenance: "official", kind: "cli", command: "unity", mcpArgs: ["mcp"], docs: "https://docs.unity.com/en-us/unity-cli/use-unity-cli", install: { type: "winget", package: "Unity.CLI" } },
  { id: "blender-cli", match: /^blender$/i, label: "Blender CLI", publisher: "blender.org", provenance: "official", kind: "cli", executable: true, docs: "https://docs.blender.org/manual/en/latest/advanced/command_line/arguments.html" },
  { id: "godot-cli", match: /^godot(?:.*)?$/i, label: "Godot CLI", publisher: "godotengine.org", provenance: "official", kind: "cli", executable: true, docs: "https://docs.godotengine.org/en/stable/tutorials/editor/command_line_tutorial.html" },
  { id: "vscode-cli", match: /^(code|code - insiders|visual studio code)$/i, label: "Visual Studio Code CLI", publisher: "code.visualstudio.com", provenance: "official", kind: "cli", command: "code", docs: "https://code.visualstudio.com/docs/configure/command-line" },
  { id: "obsidian-cli", match: /^obsidian$/i, label: "Obsidian CLI", publisher: "obsidian.md", provenance: "official", kind: "cli", command: "obsidian", docs: "https://help.obsidian.md/cli" },
  { id: "libreoffice-cli", match: /^(soffice(?:\.bin)?|libreoffice)$/i, label: "LibreOffice CLI", publisher: "libreoffice.org", provenance: "official", kind: "cli", executable: true, docs: "https://help.libreoffice.org/latest/en-US/text/shared/guide/start_parameters.html" },
];

export function fingerprint(candidate) {
  return createHash("sha256").update(JSON.stringify({ id: candidate.id, kind: candidate.kind, command: candidate.command,
    args: candidate.args, url: candidate.url, headers: candidate.headers, env: candidate.env, cwd: candidate.cwd, install: candidate.install, package: candidate.package, publisher: candidate.publisher,
    version: candidate.version, integrity: candidate.integrity, dependencyLock: candidate.dependencyLock?.sha256, provenance: candidate.provenance })).digest("hex");
}

export function validateConnector(value) {
  if (!value || typeof value !== "object" || !/^[a-zA-Z0-9._/-]{1,160}$/.test(value.id || "")
    || !["mcp", "cli", "desktop"].includes(value.kind) || typeof value.label !== "string" || !value.label.trim()) throw new Error("Connector needs an id, label and mcp/cli/desktop kind");
  if (value.url) {
    const url = new URL(value.url);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))) throw new Error("Use HTTPS, or an explicitly approved loopback HTTP endpoint");
    if (url.username || url.password) throw new Error("Keep credentials in connector environment or headers, not URLs");
  } else if (!value.command && !value.package && !value.install) throw new Error("Connector needs a command, endpoint or supported package");
  if (value.args && (!Array.isArray(value.args) || value.args.length > 100 || value.args.some(arg => typeof arg !== "string" || arg.includes("\0")))) throw new Error("Connector args must be an array of strings");
  if (value.docs && !/^https?:\/\//i.test(value.docs)) throw new Error("Connector source must be an HTTP/HTTPS URL");
  if (value.apps && (!Array.isArray(value.apps) || value.apps.some(name => typeof name !== "string"))) throw new Error("Connector apps must be a list of process names");
  if (value.package && (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(value.package.name || "") || !/^[a-zA-Z0-9.+-]{1,80}$/.test(value.package.version || ""))) throw new Error("Use a named package with an exact version, not a URL or version range");
  return { ...value, args: value.args || [], provenance: value.provenance === "official" ? "official" : "community" };
}

export function registryCandidates(payload, query, knownPublishers = []) {
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matches = new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i");
  const output = [];
  for (const row of payload.servers || []) {
    const server = row.server || row;
    if (!matches.test(`${server.name || ""} ${server.description || ""}`)) continue;
    const repository = server.repository?.url;
    const namespace = (server.name || "").split("/")[0];
    // A registry namespace establishes ownership, not endorsement by an application vendor.
    const official = knownPublishers.some(publisher => namespace === publisher);
    const base = { id: `registry/${server.name}`, label: server.title || server.name, provenance: official ? "official" : "community", publisher: namespace,
      description: String(server.description || "").slice(0, 400), docs: repository || server.websiteUrl, kind: "mcp", version: server.version, discovery: "MCP Registry" };
    for (const pkg of server.packages || []) {
      if (!["npm", "pypi"].includes(pkg.registryType) || pkg.transport?.type !== "stdio") continue;
      try { output.push(validateConnector({ ...base, id: `${base.id}/${pkg.registryType}`, package: { type: pkg.registryType, name: pkg.identifier, version: pkg.version },
        args: (pkg.packageArguments || []).flatMap(arg => typeof arg.value === "string" ? (arg.type === "named" && arg.name ? [arg.name, arg.value] : [arg.value]) : []),
        requiredEnvironment: (pkg.environmentVariables || []).filter(item => item.isRequired).map(item => item.name),
        requiresConfiguration: !!pkg.runtimeArguments?.length || (pkg.packageArguments || []).some(arg => arg.isRequired && typeof arg.value !== "string"), installed: false })); } catch { /* Unsupported registry packaging is not executable. */ }
    }
    for (const remote of server.remotes || []) {
      if (remote.type !== "streamable-http") continue;
      try { output.push(validateConnector({ ...base, id: `${base.id}/http`, url: remote.url, installed: true,
        requiredHeaders: (remote.headers || []).filter(item => item.isRequired).map(item => item.name) })); } catch { /* Do not offer an unsafe remote endpoint. */ }
    }
  }
  return output.slice(0, 12);
}

export class ConnectorCatalog {
  constructor({ fetcher = fetch, custom = () => [], home, find = findExecutable } = {}) {
    this.fetcher = fetcher; this.custom = custom; this.home = home; this.find = find; this.cache = new Map();
  }
  async discover(app, { refresh = false, signal, mcpOnly = false } = {}) {
    const term = app.name.replace(/\.exe$/i, "").trim();
    const candidates = [];
    for (const item of CATALOG.filter(item => item.match.test(term) || item.match.test(app.product || ""))) {
      const command = item.executable ? app.path : await this.find(item.command, item.id === "unity-cli" ? [path.join(os.homedir(), ".unity", "bin"), path.join(os.homedir(), ".local", "bin")] : []);
      candidates.push({ ...item, match: undefined, command: command || item.command, installed: !!command });
      if (item.mcpArgs) candidates.push({ ...item, id: `${item.id}-mcp`, label: `${item.label} MCP`, match: undefined, kind: "mcp", command: command || item.command, args: item.mcpArgs, installed: !!command });
    }
    for (const row of this.custom()) {
      const names = row.apps || [];
      if (!names.length || names.some(name => name.toLowerCase() === term.toLowerCase())) {
        try { const item = validateConnector(row); candidates.push({ ...item, installed: !!item.url || !!await this.find(item.command || "") }); } catch { /* Invalid saved entries remain visible in management diagnostics. */ }
      }
    }
    const key = `${term.toLowerCase()}:${mcpOnly}`; let error;
    if (term.length >= 2) {
      if (refresh || !this.cache.has(key) || Date.now() - this.cache.get(key).time > (this.cache.get(key).error ? 30000 : 3600000)) {
        try {
          const entries = [];
          const request = url => Promise.resolve().then(() => this.fetcher(url, { signal: AbortSignal.any([AbortSignal.timeout(8000), ...(signal ? [signal] : [])]) }));
          const [registryRequest, cliRequest] = await Promise.allSettled([
            request(`https://registry.modelcontextprotocol.io/v0.1/servers?search=${encodeURIComponent(term)}&limit=50`),
            mcpOnly ? Promise.resolve({ ok: true, text: async () => '{"objects":[]}' }) : request(`https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(`${term} cli`)}&size=10`),
          ]);
          signal?.throwIfAborted();
          try {
          if (registryRequest.status === "rejected") throw registryRequest.reason;
          const response = registryRequest.value;
          if (!response.ok) throw new Error(`MCP Registry HTTP ${response.status}`);
          const text = await response.text(); if (text.length > 2e6) throw new Error("MCP Registry response too large");
          entries.push(...registryCandidates(JSON.parse(text), term));
          } catch (failure) { if (signal?.aborted) throw failure; error = `MCP search: ${failure.message}`; }
          // CLI packages have no MCP registry. Search the public npm index too,
          // but never execute search results before a reviewed installation plan.
          try {
            if (cliRequest.status === "rejected") throw cliRequest.reason;
            const npmResponse = cliRequest.value;
            if (!npmResponse.ok) throw new Error(`npm HTTP ${npmResponse.status}`);
            if (npmResponse.ok) {
              const npmText = await npmResponse.text(); if (npmText.length > 1e6) throw new Error("CLI search response too large");
              const word = new RegExp(`(^|[^a-z0-9])${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`, "i");
              for (const { package: pkg } of JSON.parse(npmText).objects || []) {
                if (!word.test(`${pkg.name} ${pkg.description || ""}`) || !/\bcli\b|command.line/i.test(`${pkg.name} ${pkg.description || ""} ${(pkg.keywords || []).join(" ")}`)) continue;
                try { entries.push(validateConnector({ id: `npm/${pkg.name}`, label: pkg.name, kind: "cli", provenance: "community", publisher: pkg.publisher?.username || "npm community",
                  description: String(pkg.description || "").slice(0, 300), docs: pkg.links?.repository || pkg.links?.npm,
                  package: { type: "npm", name: pkg.name, version: pkg.version }, installed: false, discovery: "npm CLI search" })); } catch { /* Do not offer invalid package specs. */ }
                if (entries.length >= 18) break;
              }
            }
          } catch (failure) { if (signal?.aborted) throw failure; error = [error, `CLI search: ${failure.message}`].filter(Boolean).join("; "); }
          this.cache.set(key, { time: Date.now(), entries, error });
        } catch (failure) { if (signal?.aborted) throw failure; error = failure.message; }
      }
      candidates.push(...(this.cache.get(key)?.entries || []).filter(item => !candidates.some(existing => existing.id === item.id)));
      error ||= this.cache.get(key)?.error;
    }
    return { candidates: [...new Map(candidates.map(item => [item.id, item])).values()].sort((a, b) => (a.provenance !== "official") - (b.provenance !== "official") || Number(b.installed) - Number(a.installed)),
      ...(error ? { discoveryError: error } : {}), query: term,
      searches: [{ label: "Official documentation / CLI", url: `https://www.google.com/search?q=${encodeURIComponent(`${app.product || term} official CLI MCP documentation`)}` },
        { label: "Community MCP / CLI", url: `https://github.com/search?q=${encodeURIComponent(`${term} MCP CLI`)}&type=repositories` }],
      note: "No matching result means not discovered, not proof that the application has no MCP or CLI. Add a reviewed connector from its official documentation or repository." };
  }
}
