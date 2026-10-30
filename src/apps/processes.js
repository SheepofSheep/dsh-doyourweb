import { execFile, spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import path from "node:path";
import { windowsInventory, usefulWindows } from "./windows.js";
import { windowsWorker } from "./powershell.js";

export const runFile = promisify(execFile);

export class AppUnavailable extends Error {
  constructor(message = "Application exited or its window changed; use a background MCP/CLI or read app_desktop to open the selected application automatically") { super(message); this.code = "APP_WINDOW_UNAVAILABLE"; }
}

let installedCache, installedAt = 0;
export async function installedApplications(signal) {
  if (installedCache && Date.now() - installedAt < 60000) return installedCache;
  const script = String.raw`$ErrorActionPreference='SilentlyContinue';[Console]::OutputEncoding=[Text.UTF8Encoding]::new();$shell=New-Object -ComObject WScript.Shell
$roots=@([Environment]::GetFolderPath('StartMenu'),[Environment]::GetFolderPath('CommonStartMenu'))
@(foreach($root in $roots){Get-ChildItem -LiteralPath $root -Filter *.lnk -Recurse | ForEach-Object {
  $link=$shell.CreateShortcut($_.FullName);$exe=[Environment]::ExpandEnvironmentVariables($link.TargetPath)
  if($exe -match '\.exe$' -and (Test-Path -LiteralPath $exe) -and $_.BaseName -notmatch '(?i)uninstall|卸载'){
    [pscustomobject]@{name=[IO.Path]::GetFileNameWithoutExtension($exe);title=$_.BaseName;path=$exe;installed=$true}
  }
}}) | ConvertTo-Json -Compress`;
  const { stdout } = await runFile("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { windowsHide: true, timeout: 10000, maxBuffer: 2 * 1024 * 1024, signal });
  const rows = stdout.trim() ? JSON.parse(stdout.replace(/^\uFEFF/, "")) : [];
  installedCache = [...new Map([rows].flat().map(row => [row.path.toLowerCase(), row])).values()]; installedAt = Date.now();
  return installedCache;
}

export async function launchApplication(app, signal) {
  signal?.throwIfAborted();
  if (!path.isAbsolute(app.path || "") || !/\.exe$/i.test(app.path)) throw new AppUnavailable("This app has no executable path; choose its installed entry with @ or use its MCP/CLI connector");
  await new Promise((resolve, reject) => {
    // This is the selected interactive app, not a hidden connector/helper process.
    // Do not force its initial window hidden: the desktop driver must be able to find it.
    const child = spawn(app.path, [], { detached: true, stdio: "ignore", windowsHide: false, shell: false });
    child.once("error", reject); child.once("spawn", () => { child.unref(); resolve(); });
  });
}

export async function processWindows({ signal } = {}) {
  if (process.platform === "win32") {
    const { stdout } = await windowsWorker.run(windowsInventory, { signal });
    const value = stdout.trim() ? JSON.parse(stdout.replace(/^\uFEFF/, "")) : [];
    const windows = usefulWindows(Array.isArray(value) ? value : [value]);
    return windows;
  }
  throw new Error("Running-app inventory currently requires Windows; configure a desktop connector for this platform");
}

export async function findExecutable(command, extra = []) {
  if (!command || typeof command !== "string") return;
  const extensions = process.platform === "win32" && !path.extname(command) ? [".exe", ".cmd", ".bat", ""] : [""];
  const directories = path.isAbsolute(command) ? [""] : [...extra, ...(process.env.PATH || "").split(path.delimiter)];
  for (const directory of directories) for (const extension of extensions) {
    const file = path.resolve(directory, command + extension);
    try { if ((await stat(file)).isFile()) return file; } catch { /* Continue PATH search. */ }
  }
}

export class AppInventory {
  constructor({ inventory = processWindows, launch = launchApplication, wait = delay } = {}) { this.inventory = inventory; this.launch = launch; this.wait = wait; this.runtime = randomUUID(); this.apps = new Map(); this.known = new Map(); this.launching = new Map(); this.attempted = new Set(); this.updated = 0; this.pending = undefined; }
  async list(query = "", signal, refresh = false) {
    signal?.throwIfAborted();
    if (refresh || Date.now() - this.updated > 2500) {
      if (!this.pending) this.pending = (async () => {
        const rows = await this.inventory({ signal }); const next = new Map();
        for (const row of rows.slice(0, 500)) {
          const identity = createHash("sha256").update(`${row.pid}:${row.windowId}:${row.started}:${row.path || row.name}`).digest("hex").slice(0, 24);
          const ref = `dsh-app://${this.runtime}/${identity}`;
          next.set(ref, { ...row, ref });
        }
        // Keep an explicitly selected identity usable by background connectors after its window closes.
        for (const [ref, row] of next) this.known.set(ref, row);
        for (const [ref, row] of this.apps) if (!next.has(ref) && [...next.values()].some(item => item.pid === row.pid && item.windowId === row.windowId && item.started === row.started)) next.set(ref, row);
        while (this.known.size > 500) this.known.delete(this.known.keys().next().value);
        this.apps = next; this.updated = Date.now();
      })().finally(() => { this.pending = undefined; });
      await this.pending;
    }
    signal?.throwIfAborted();
    const needle = query.trim().toLowerCase().replace(/\.exe$/, "");
    return [...new Map([...this.apps.values()].map(app => [`${app.pid}:${app.windowId}:${app.started}:${app.path}`, app])).values()].filter(app => !needle || `${app.name} ${app.product || ""} ${app.displayName || ""} ${app.title}`.toLowerCase().includes(needle)).slice(0, 60);
  }
  async resolve(ref, signal, { fresh = false, window = true } = {}) {
    signal?.throwIfAborted();
    if (!window) { const app = this.known.get(ref); if (!app) throw new AppUnavailable(); return app; }
    if (!this.apps.has(ref)) throw new AppUnavailable();
    await this.list("", signal, fresh); const app = this.apps.get(ref);
    if (!app?.windowId) throw new AppUnavailable();
    return app;
  }
  async ensureWindow(ref, signal) {
    if (this.launching.has(ref)) return this.launching.get(ref);
    const job = this.openWindow(ref, signal); this.launching.set(ref, job);
    try { return await job; } finally { this.launching.delete(ref); }
  }
  async showWindow(ref, signal) {
    const app = await this.resolve(ref, signal, { fresh: true });
    if (process.platform !== "win32" || !/^\d+$/.test(String(app.windowId)) || !Number.isSafeInteger(app.pid)) return false;
    const script = `if (-not ('DshShowWindow' -as [type])) { Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public class DshShowWindow {
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr w, out uint p);
 [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr w);
 [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr w, int c);
 [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr w);
}
'@ }
$w=[IntPtr]::new([long]${app.windowId});[uint32]$p=0
[void][DshShowWindow]::GetWindowThreadProcessId($w,[ref]$p)
if($p -eq ${app.pid}) { if([DshShowWindow]::IsIconic($w)){[void][DshShowWindow]::ShowWindowAsync($w,9)};[void][DshShowWindow]::SetForegroundWindow($w) }`;
    await windowsWorker.run(script, { timeout: 5000, signal });
    return true;
  }
  async openWindow(ref, signal) {
    const selected = await this.resolve(ref, signal, { window: false });
    await this.list("", signal, true);
    const current = this.apps.get(ref);
    if (current?.windowId) { this.attempted.delete(ref); return current; }
    const match = () => {
      const rows = [...new Map([...this.apps.values()].filter(row => row.windowId && row.path && row.path.toLowerCase() === selected.path?.toLowerCase()).map(row => [`${row.pid}:${row.windowId}`, row])).values()];
      if (rows.length > 1) throw new AppUnavailable("Several windows belong to this app; select the intended window with @");
      if (!rows.length) return;
      const app = { ...rows[0], ref }; this.apps.set(ref, app); this.known.set(ref, app); this.attempted.delete(ref); return app;
    };
    const existing = match(); if (existing) return existing;
    if (this.attempted.has(ref)) throw new AppUnavailable("Automatic launch did not produce an available window. Use the app's background MCP/CLI or computer-use launch workflow; do not repeat inputs with uncertain effects.");
    this.attempted.add(ref); await this.launch(selected, signal);
    for (let attempt = 0; attempt < 8; attempt++) {
      await this.wait(500, undefined, { signal }); await this.list("", signal, true);
      const app = match(); if (app) return app;
    }
    throw new AppUnavailable("The app was launched but no window is ready yet. Use its background connector or inspect the launch with computer use; do not replay an earlier action.");
  }
}

export const appRefs = text => [...new Set(text.match(/dsh-app:\/\/[a-f0-9-]{36}\/[a-f0-9]{24}/gi) || [])];
