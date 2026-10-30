import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

// Only internal scripts enter this worker. Each reply is one JSON line; scripts
// retain their loaded Win32 types across inventory/focus requests.
export class PowerShellWorker {
  constructor() { this.queue = Promise.resolve(); }
  run(script, { signal, timeout = 10000 } = {}) {
    const job = this.queue.catch(() => {}).then(async () => {
      signal?.throwIfAborted();
      clearTimeout(this.idle);
      if (!this.child) {
        const source = String.raw`[Console]::OutputEncoding=[Text.UTF8Encoding]::new()
while($null -ne ($line=[Console]::ReadLine())) {
  try {
    $ErrorActionPreference='Stop'
    $code=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($line))
    $output=(& ([ScriptBlock]::Create($code)) | Out-String).Trim()
    [Console]::WriteLine((@{output=$output} | ConvertTo-Json -Compress))
  } catch { [Console]::WriteLine((@{error=$_.Exception.Message} | ConvertTo-Json -Compress)) }
}`;
        const child = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(source, "utf16le").toString("base64")], { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
        this.child = child;
        createInterface({ input: child.stdout }).on("line", line => {
          const pending = this.pending;
          if (!pending) return;
          this.pending = undefined;
          try { const value = JSON.parse(line); value.error ? pending.reject(new Error(value.error)) : pending.resolve({ stdout: value.output }); }
          catch (error) { pending.reject(error); this.close(); }
        });
        const failed = error => {
          if (this.child !== child) return;
          this.child = undefined;
          this.pending?.reject(error); this.pending = undefined;
        };
        child.once("error", failed);
        child.stdin.on("error", failed);
        child.once("exit", () => failed(new Error("Windows helper exited; no operation was retried")));
      }
      this.child.ref(); this.child.stdin.ref(); this.child.stdout.ref();
      const abort = () => { this.pending?.reject(signal.reason); this.close(); };
      const timer = setTimeout(() => { this.pending?.reject(new Error("Windows helper timed out; no operation was retried")); this.close(); }, timeout);
      signal?.addEventListener("abort", abort, { once: true });
      try {
        return await new Promise((resolve, reject) => {
          this.pending = { resolve, reject };
          this.child.stdin.write(Buffer.from(script).toString("base64") + "\n");
        });
      } finally {
        clearTimeout(timer); signal?.removeEventListener("abort", abort);
        this.idle = setTimeout(() => this.close(), 30000); this.idle.unref();
        this.child?.unref(); this.child?.stdin.unref(); this.child?.stdout.unref();
      }
    });
    this.queue = job; return job;
  }
  close() {
    clearTimeout(this.idle);
    const child = this.child; this.child = undefined;
    this.pending?.reject(new Error("Windows helper stopped")); this.pending = undefined;
    child?.kill();
  }
}

export const windowsWorker = new PowerShellWorker();
