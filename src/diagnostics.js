import { randomUUID } from "node:crypto";

// Deliberately accept metadata only. Neither command params nor raw errors enter this store.
export class Diagnostics {
  constructor({ capacity = 600, version = "unknown" } = {}) {
    this.capacity = capacity;
    this.version = version;
    this.enabled = true;
    this.events = [];
    this.run = randomUUID().slice(0, 8);
  }
  record({ id = "", method = "", phase, elapsedMs = 0, error, extensionVersion } = {}) {
    if (!this.enabled) return;
    const code = !error ? undefined : /timed?\s*out|timeout/i.test(error.message || error) ? "TIMEOUT"
      : /disconnect|closed|stopped/i.test(error.message || error) ? "DISCONNECTED"
        : /permission|denied|not allowed/i.test(error.message || error) ? "PERMISSION" : "COMMAND_FAILED";
    this.events.push({ time: new Date().toISOString(), correlationId: `${this.run}:${id}`,
      method: /^[A-Za-z][\w.]{0,99}$/.test(method) ? method : "unknown", phase,
      elapsedMs: Math.max(0, Math.round(elapsedMs)), ...(code ? { code } : {}), version: this.version,
      ...(/^[\d.]{1,24}$/.test(extensionVersion || "") ? { extensionVersion } : {}) });
    if (this.events.length > this.capacity) this.events.splice(0, this.events.length - this.capacity);
  }
  state({ clear = false, enabled } = {}) {
    if (enabled !== undefined) this.enabled = enabled;
    if (clear) this.events.length = 0;
    return { enabled: this.enabled, capacity: this.capacity, events: this.events.slice(), version: this.version };
  }
}
