import path from "node:path";
import { readFile, writeFile, rename, stat, unlink } from "node:fs/promises";

// The index starts with this version. Older unindexed screenshots and files a
// person replaces/edits are never adopted or removed by retention.
export class CaptureStore {
  constructor(directory, { maxFiles = 50, maxAgeMs = 24 * 60 * 60 * 1000, now = () => Date.now() } = {}) {
    this.directory = directory;
    this.maxFiles = maxFiles;
    this.maxAgeMs = maxAgeMs;
    this.now = now;
    this.queue = Promise.resolve();
  }
  record(file) {
    const result = this.queue.then(async () => {
      const index = path.join(this.directory, ".dsh-owned-captures.json");
      if (!this.entries) {
        let data;
        try { data = JSON.parse(await readFile(index, "utf8")); }
        catch (error) { if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error; }
        this.entries = Array.isArray(data) ? data.filter(entry => entry && /^dsh-capture-[a-f0-9-]{36}\.png$/.test(entry.name)
          && [entry.created, entry.ino, entry.birthtimeMs, entry.mtimeMs, entry.size].every(Number.isFinite)) : [];
      }
      const info = await stat(file);
      this.entries.push({ name: path.basename(file), created: this.now(), ino: info.ino,
        birthtimeMs: info.birthtimeMs, mtimeMs: info.mtimeMs, size: info.size });
      const retained = [];
      for (let position = 0; position < this.entries.length; position++) {
        const entry = this.entries[position];
        if (position >= this.entries.length - this.maxFiles && this.now() - entry.created <= this.maxAgeMs) { retained.push(entry); continue; }
        const target = path.join(this.directory, entry.name);
        let current;
        try { current = await stat(target); } catch (error) { if (error.code !== "ENOENT") throw error; }
        if (current && current.ino === entry.ino && current.birthtimeMs === entry.birthtimeMs
          && current.mtimeMs === entry.mtimeMs && current.size === entry.size) await unlink(target);
      }
      this.entries = retained;
      await writeFile(`${index}.tmp`, JSON.stringify(retained), { mode: 0o600 });
      await rename(`${index}.tmp`, index);
    });
    this.queue = result.catch(() => {});
    return result;
  }
}
