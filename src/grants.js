import { readFile, writeFile, mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { parseRef } from "./protocol.js";

/**
 * The tabs a conversation's user explicitly cited with `@`.
 *
 * DSH runs `agent/pre-step` once per step with only that step's claimed input
 * batch, so an authorization set rebuilt from every batch is empty as soon as a
 * step carries tool results instead of the user message. Grants therefore
 * accumulate per session and survive a DSH restart in `authorized.json`; only
 * references found in user-role messages are ever added.
 */
export class Grants {
  constructor({ file, sessions = 50, perSession = 50, onError = () => {} } = {}) {
    this.file = file;
    this.sessionLimit = sessions;
    this.sessionSize = perSession;
    this.onError = onError;
    this.sessions = new Map();
    this.writes = Promise.resolve();
  }

  async load() {
    if (!this.file) return this;
    let stored;
    try { stored = JSON.parse(await readFile(this.file, "utf8")); }
    catch (error) { if (error.code !== "ENOENT") this.onError(error); return this; }
    for (const [sessionId, refs] of Object.entries(stored?.sessions ?? {})) {
      if (typeof sessionId !== "string" || !Array.isArray(refs)) continue;
      const kept = refs.filter(ref => typeof ref === "string" && valid(ref)).slice(-this.sessionSize);
      if (kept.length) this.sessions.set(sessionId, new Set(kept));
    }
    while (this.sessions.size > this.sessionLimit) this.sessions.delete(this.sessions.keys().next().value);
    return this;
  }

  /** The authorized set for one session; never undefined, so callers compare with `size`. */
  get(sessionId) {
    return this.sessions.get(sessionId) ?? EMPTY;
  }

  /** Add references cited by the user; returns whether anything new was granted. */
  async allow(sessionId, refs) {
    const accepted = refs.filter(valid);
    if (!accepted.length) return false;
    let allowed = this.sessions.get(sessionId);
    let changed = false;
    if (!allowed) { allowed = new Set(); this.sessions.set(sessionId, allowed); }
    for (const ref of accepted) {
      // Re-citing a tab refreshes its position. Without this, eviction is by
      // first-seen order, so a tab cited at the start of a long conversation is
      // dropped first and every later call fails with "not referenced by the user"
      // even though the user did cite it.
      if (allowed.has(ref)) { allowed.delete(ref); allowed.add(ref); continue; }
      allowed.add(ref);
      changed = true;
    }
    if (!changed) return false;
    while (allowed.size > this.sessionSize) allowed.delete(allowed.values().next().value);
    // Touch the session so a long-lived conversation is not evicted by newer ones.
    if (this.sessions.has(sessionId)) { const current = this.sessions.get(sessionId); this.sessions.delete(sessionId); this.sessions.set(sessionId, current); }
    while (this.sessions.size > this.sessionLimit) this.sessions.delete(this.sessions.keys().next().value);
    await this.save();
    return true;
  }

  /** Persist the live grants, serialized so concurrent steps cannot interleave. */
  save() {
    if (!this.file) return this.writes;
    const content = `${JSON.stringify({ version: 1, sessions: Object.fromEntries(
      [...this.sessions].map(([sessionId, refs]) => [sessionId, [...refs]])) })}\n`;
    this.writes = this.writes.then(async () => {
      const temporary = `${this.file}.${process.pid}.tmp`;
      try {
        await mkdir(path.dirname(this.file), { recursive: true });
        await writeFile(temporary, content, { mode: 0o600 });
        await rename(temporary, this.file);
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => {});
        this.onError(error);
      }
    });
    return this.writes;
  }
}

const EMPTY = new Set();

function valid(ref) {
  try { parseRef(ref); return true; } catch { return false; }
}
