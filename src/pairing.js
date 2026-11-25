import { randomUUID, randomInt, createHash } from "node:crypto";

/** Chrome extension ids are the first 16 bytes of SHA-256(key), hex folded to a-p. */
export function extensionId(key) {
  return createHash("sha256").update(Buffer.from(key, "base64")).digest("hex")
    .slice(0, 32).replace(/[0-9a-f]/g, c => String.fromCharCode(97 + parseInt(c, 16)));
}

/**
 * The committed manifest key pins the extension id for every installation: the
 * unpacked folder can be loaded as-is (no generated copy), and the bridge can
 * restrict the WebSocket origin to exactly that id.
 */
export function manifestKey(manifest) {
  if (typeof manifest?.key !== "string" || manifest.key.length === 0) {
    throw new Error("The companion extension manifest must pin a key so its id is stable");
  }
  return manifest.key;
}

export function pinnedExtensionId(manifest) {
  return extensionId(manifestKey(manifest));
}

/**
 * One-time pairing of a freshly loaded browser extension.
 *
 * A secret cannot be shipped to the browser, and an unpacked extension can only
 * be recognised by its (forgeable) `Origin`, so pairing must be confirmed by the
 * person at the keyboard: the extension is shown a short code, the DSH setup page
 * lists the same code for the pending request, and the user approves the request
 * whose code matches the extension's toolbar badge.
 *
 * A four-digit code is not a secret — the space is 10,000 and a local process can
 * open thousands of requests per second — so the code alone cannot be the gate.
 * What makes the comparison meaningful is that a code is unique among the pending
 * requests: an impostor cannot obtain a row bearing the real extension's code, so
 * the user's match identifies exactly one request. Codes are additionally drawn
 * from a larger space and request creation is rate-limited, so guessing the real
 * code (as opposed to colliding with it) is not viable either.
 */
export class Pairings {
  constructor({ ttlMs = 120000, maxPending = 4, maxRequestsPerWindow = 30, now = () => Date.now() } = {}) {
    this.ttlMs = ttlMs;
    this.maxPending = maxPending;
    this.maxRequestsPerWindow = maxRequestsPerWindow;
    this.now = now;
    this.pending = new Map();
    this.issued = [];
  }

  /** A code no other pending request is showing, so a match identifies one row. */
  uniqueCode() {
    const shown = new Set([...this.pending.values()].map(entry => entry.code));
    for (let attempt = 0; attempt < 100; attempt++) {
      const code = String(randomInt(0, 1000000)).padStart(6, "0");
      if (!shown.has(code)) return code;
    }
    // Every candidate collided, which means the pending set is pathologically
    // large; refuse rather than reuse a code and make the comparison ambiguous.
    return undefined;
  }

  /** Register a request for one connecting socket; returns undefined when refused. */
  request(socket) {
    this.prune();
    if (this.pending.size >= this.maxPending) return undefined;
    // Bound how fast requests can be minted. Legitimate use is a reconnect or two
    // per pairing window; anything near this ceiling is enumeration.
    const cutoff = this.now() - this.ttlMs;
    while (this.issued.length && this.issued[0] <= cutoff) this.issued.shift();
    if (this.issued.length >= this.maxRequestsPerWindow) return undefined;
    const code = this.uniqueCode();
    if (code === undefined) return undefined;
    this.issued.push(this.now());
    const entry = { id: randomUUID().slice(0, 8), code, socket, created: this.now(), expires: this.now() + this.ttlMs };
    this.pending.set(entry.id, entry);
    return entry;
  }

  /** Live requests, newest last, for the setup page. */
  list() {
    this.prune();
    return [...this.pending.values()].map(({ id, code, created, expires }) => ({ id, code, created, expires }));
  }

  /** Consume one request; approval and denial are both single use. */
  take(id) {
    this.prune();
    const entry = this.pending.get(id);
    if (entry === undefined) return undefined;
    this.pending.delete(id);
    return entry;
  }

  /** Forget the request a socket opened when it disconnects. */
  drop(socket) {
    for (const [id, entry] of this.pending) if (entry.socket === socket) this.pending.delete(id);
  }

  prune() {
    const now = this.now();
    for (const [id, entry] of this.pending) if (entry.expires <= now) {
      this.pending.delete(id);
      entry.socket.close?.(1000, "Pairing expired");
    }
  }
}
