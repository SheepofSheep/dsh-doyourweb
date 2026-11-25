import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { runProcess } from "./runtime.js";
import { findExecutable } from "./processes.js";

export function managedDirectory(home, id) { return path.join(home, "connectors", createHash("sha256").update(id).digest("hex").slice(0, 24)); }

async function fetchJson(url, signal, fetcher = fetch) {
  const response = await fetcher(url, { signal: AbortSignal.any([AbortSignal.timeout(15000), ...(signal ? [signal] : [])]), headers: { "User-Agent": "dsh-doyourweb" } });
  if (!response.ok) throw new Error(`Package metadata HTTP ${response.status}`);
  const text = await response.text(); if (text.length > 3e6) throw new Error("Package metadata too large"); return JSON.parse(text);
}

export function reviewedNpmLock(candidate) {
  const reviewed = candidate.dependencyLock;
  if (!reviewed || typeof reviewed.json !== "string" || createHash("sha256").update(reviewed.json).digest("hex") !== reviewed.sha256) throw new Error("Reviewed npm dependency lock is missing or changed; request a fresh approval");
  const lock = JSON.parse(reviewed.json), name = candidate.package.name;
  if (lock.lockfileVersion !== 3 || lock.packages?.[""]?.dependencies?.[name] !== candidate.package.version
    || Object.keys(lock.packages[""].dependencies).length !== 1
    || lock.packages?.[`node_modules/${name}`]?.version !== candidate.package.version
    || lock.packages?.[`node_modules/${name}`]?.integrity !== candidate.integrity) throw new Error("Reviewed npm dependency lock differs from the selected package");
  for (const [location, item] of Object.entries(lock.packages)) {
    if (!location) continue;
    if (item.link || !item.version || (!item.inBundle && (!/^sha(?:256|384|512)-/.test(item.integrity || "") || !/^https:\/\/registry\.npmjs\.org\//.test(item.resolved || "")))) throw new Error("npm dependency lock contains an unpinned or unsupported source; configure a reviewed local installation instead");
  }
  return lock;
}

export async function preparePackage(candidate, signal, { home = os.tmpdir(), run = runProcess, find = findExecutable, fetcher = fetch } = {}) {
  if (!candidate.package) return candidate;
  const pkg = candidate.package;
  if (pkg.type === "npm") {
    const metadata = await fetchJson(`https://registry.npmjs.org/${encodeURIComponent(pkg.name)}/${encodeURIComponent(pkg.version)}`, signal, fetcher);
    if (metadata.name !== pkg.name || metadata.version !== pkg.version) throw new Error("Registry package identity changed");
    const bins = typeof metadata.bin === "string" ? { [pkg.name.split("/").at(-1)]: metadata.bin } : metadata.bin || {};
    const entry = pkg.entry || (Object.keys(bins).length === 1 ? Object.keys(bins)[0] : undefined);
    if (!entry || !Object.hasOwn(bins, entry) || !/^[\w.-]+$/.test(entry)) throw new Error("Package exposes no unambiguous executable; configure package.entry in the connector");
    if (!/^sha(?:256|384|512)-/.test(metadata.dist?.integrity || "")) throw new Error("Package has no supported integrity digest; review and configure a local installation instead");
    const prepared = { ...candidate, package: { ...pkg, entry }, integrity: metadata.dist.integrity, install: { type: "npm", package: `${pkg.name}@${pkg.version}`, scripts: false } };
    const npm = await find(process.platform === "win32" ? "npm.cmd" : "npm"); if (!npm) throw new Error("Install Node.js/npm first; dependency review requires npm");
    const plans = path.join(home, "connector-plans"); await mkdir(plans, { recursive: true });
    const directory = await mkdtemp(path.join(plans, "npm-"));
    try {
      await writeFile(path.join(directory, "package.json"), JSON.stringify({ name: "dsh-reviewed-connector", version: "1.0.0", private: true, dependencies: { [pkg.name]: pkg.version } }), { mode: 0o600 });
      const result = await run(npm, ["install", "--package-lock-only", "--lockfile-version=3", "--ignore-scripts", "--no-audit", "--no-fund", "--registry=https://registry.npmjs.org/"], { cwd: directory, env: { NPM_CONFIG_CACHE: path.join(home, "npm-cache") }, signal, timeout: 180000 });
      if (result.exitCode !== 0) throw new Error(`npm dependency review failed: ${result.stderr}`);
      const json = await readFile(path.join(directory, "package-lock.json"), "utf8");
      prepared.dependencyLock = { json, sha256: createHash("sha256").update(json).digest("hex"), packages: Object.keys(JSON.parse(json).packages || {}).length - 1 };
      reviewedNpmLock(prepared); return prepared;
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
  if (pkg.type === "pypi") return { ...candidate, install: { type: "pypi", package: `${pkg.name}==${pkg.version}` } };
  throw new Error("Package registry type is not supported; add an explicit installed command");
}

export function desktopCandidate() {
  return { id: "cua-driver", label: "Cua Driver (DSH computer-use upstream)", kind: "desktop", provenance: "official", publisher: "github.com/trycua/cua",
    version: "0.28.0", command: "cua-driver", args: ["mcp"], docs: "https://github.com/trycua/cua/tree/cua-driver-rs-v0.28.0/libs/cua-driver",
    install: { type: "cua-release", tag: "cua-driver-rs-v0.28.0" } };
}

export async function installConnector(candidate, home, signal, { run = runProcess, find = findExecutable } = {}) {
  const directory = managedDirectory(home, candidate.id);
  await mkdir(directory, { recursive: true });
  const install = candidate.install;
  if (install?.type === "npm") {
    const reviewed = reviewedNpmLock(candidate);
    const npm = await find(process.platform === "win32" ? "npm.cmd" : "npm"); if (!npm) throw new Error("Install Node.js/npm first; no npm executable was found");
    await writeFile(path.join(directory, "package.json"), JSON.stringify({ name: "dsh-reviewed-connector", version: "1.0.0", private: true, dependencies: reviewed.packages[""].dependencies }), { mode: 0o600 });
    await writeFile(path.join(directory, "package-lock.json"), candidate.dependencyLock.json, { mode: 0o600 });
    const result = await run(npm, ["ci", "--ignore-scripts", "--no-audit", "--no-fund", "--registry=https://registry.npmjs.org/"], { cwd: directory, env: { NPM_CONFIG_CACHE: path.join(directory, "cache") }, signal, timeout: 180000 });
    if (result.exitCode !== 0) throw new Error(`npm install failed: ${result.stderr}`);
    const manifest = JSON.parse(await readFile(path.join(directory, "node_modules", ...candidate.package.name.split("/"), "package.json"), "utf8"));
    if (manifest.version !== candidate.package.version) throw new Error("Installed package version differs from reviewed version");
    const installedLock = await readFile(path.join(directory, "package-lock.json"), "utf8");
    if (installedLock !== candidate.dependencyLock.json) throw new Error("npm dependency lock changed during installation; refusing to execute");
    return { ...candidate, command: path.join(directory, "node_modules", ".bin", candidate.package.entry + (process.platform === "win32" ? ".cmd" : "")), installed: true };
  }
  if (install?.type === "pypi") {
    const uv = await findExecutable("uv"); if (!uv) throw new Error("Install uv first, or configure this Python MCP with an existing command");
    const bin = path.join(directory, "bin");
    const result = await runProcess(uv, ["tool", "install", install.package], { env: { UV_TOOL_DIR: path.join(directory, "tools"), UV_TOOL_BIN_DIR: bin, UV_CACHE_DIR: path.join(directory, "cache") }, signal, timeout: 180000 });
    if (result.exitCode !== 0) throw new Error(`Python tool install failed: ${result.stderr}`);
    const files = (await readdir(bin)).filter(name => process.platform !== "win32" || name.endsWith(".exe"));
    const entry = candidate.package.entry || (files.length === 1 ? files[0] : undefined);
    if (!entry || path.basename(entry) !== entry || !files.includes(entry)) throw new Error("Installed Python package has multiple entry points; choose package.entry in management");
    return { ...candidate, command: path.join(bin, entry), installed: true };
  }
  if (install?.type === "winget") {
    if (process.platform !== "win32" || !/^[A-Za-z0-9._-]+$/.test(install.package)) throw new Error("This installer requires Windows winget");
    const winget = await findExecutable("winget"); if (!winget) throw new Error("Windows App Installer/winget is not installed");
    const result = await runProcess(winget, ["install", "--id", install.package, "--exact", "--source", "winget", "--disable-interactivity"], { signal, timeout: 180000 });
    if (result.exitCode !== 0) throw new Error(`winget could not finish. Review any license or OS confirmation in Windows, then retry: ${result.stdout} ${result.stderr}`);
    const command = await findExecutable(candidate.command); if (!command) throw new Error("Installed, but the command is not yet in the DSH process PATH; restart DSH or set its absolute path");
    return { ...candidate, command, installed: true };
  }
  if (install?.type === "cua-release") {
    const platform = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "darwin" : "linux";
    const arch = process.arch === "arm64" ? "arm64" : "x86_64";
    const release = await fetchJson(`https://api.github.com/repos/trycua/cua/releases/tags/${encodeURIComponent(install.tag)}`, signal);
    const name = `cua-driver-rs-${candidate.version}-${platform}-${arch}${platform === "windows" ? "-binary.zip" : ".tar.gz"}`;
    const asset = release.assets?.find(item => item.name === name);
    if (!asset?.digest?.startsWith("sha256:") || !asset.browser_download_url.startsWith("https://github.com/trycua/cua/releases/download/")) throw new Error("No verified Cua Driver binary is available for this OS/architecture");
    const response = await fetch(asset.browser_download_url, { signal: AbortSignal.any([AbortSignal.timeout(120000), ...(signal ? [signal] : [])]) }); if (!response.ok) throw new Error(`Driver download HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > 150e6 || `sha256:${createHash("sha256").update(bytes).digest("hex")}` !== asset.digest) throw new Error("Driver download checksum mismatch or oversized archive");
    const archive = path.join(directory, name); await writeFile(archive, bytes, { mode: 0o600 });
    const unpack = path.join(directory, `binary-${randomUUID()}`); await mkdir(unpack, { recursive: true });
    if (platform === "windows") {
      const payload = Buffer.from(JSON.stringify({ archive, unpack }), "utf8").toString("base64");
      // ZipFile.ExtractToDirectory on .NET Framework (Windows PowerShell 5.1) does
      // not reject `..` entries, so every entry is resolved and checked against the
      // destination first — the same guarantee the tar branch below already makes.
      const script = `$ErrorActionPreference='Stop';Add-Type -AssemblyName System.IO.Compression.FileSystem;$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}'))|ConvertFrom-Json;$root=[IO.Path]::GetFullPath($p.unpack).TrimEnd([IO.Path]::DirectorySeparatorChar)+[IO.Path]::DirectorySeparatorChar;$zip=[IO.Compression.ZipFile]::OpenRead($p.archive);try{foreach($entry in $zip.Entries){$target=[IO.Path]::GetFullPath([IO.Path]::Combine($p.unpack,$entry.FullName));if(-not $target.StartsWith($root,[StringComparison]::OrdinalIgnoreCase)){throw "Unsafe driver archive path: $($entry.FullName)"}}}finally{$zip.Dispose()};[IO.Compression.ZipFile]::ExtractToDirectory($p.archive,$p.unpack)`;
      const result = await runProcess("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { signal, timeout: 30000 });
      if (result.exitCode !== 0) throw new Error(`Driver archive extraction failed: ${result.stderr}`);
    } else {
      const listing = await runProcess("tar", ["-tzf", archive], { signal });
      if (listing.exitCode !== 0 || listing.stdout.split("\n").some(name => name.startsWith("/") || name.split("/").includes(".."))) throw new Error("Unsafe driver archive paths");
      const result = await runProcess("tar", ["-xzf", archive, "-C", unpack], { signal }); if (result.exitCode !== 0) throw new Error("Driver extraction failed");
    }
    async function locate(dir, depth = 0) {
      if (depth > 3) return;
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.name === (process.platform === "win32" ? "cua-driver.exe" : "cua-driver") && (await stat(file)).isFile()) return file;
        if (entry.isDirectory()) { const found = await locate(file, depth + 1); if (found) return found; }
      }
    }
    const command = await locate(unpack); if (!command) throw new Error("Downloaded archive does not contain cua-driver");
    return { ...candidate, command, installed: true };
  }
  throw new Error("No automatic installer is available; configure an installed executable or remote MCP URL");
}
