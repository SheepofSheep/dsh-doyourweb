import { clip } from "./output.js";

// Keep metadata only, without retaining Playwright Request/Response objects or bodies.
export class NetworkCapture {
  constructor(page) {
    this.page = page;
    this.active = true;
    this.since = new Date().toISOString();
    this.sequence = 0;
    this.dropped = 0;
    this.rows = [];
    this.requests = new WeakMap();
    this.listeners = {
      request: request => {
        const url = new URL(request.url());
        if (!["http:", "https:"].includes(url.protocol)) return;
        const row = { id: ++this.sequence, method: clip(request.method(), 16), url: clip(`${url.origin}${url.pathname}`, 200),
          type: request.resourceType(), time: Date.now(), state: "pending" };
        this.requests.set(request, row); this.rows.push(row);
        if (this.rows.length > 200) { this.rows.shift(); this.dropped++; }
      },
      response: response => {
        const row = this.requests.get(response.request());
        if (!row) return;
        row.status = response.status();
        // Only the media type, never raw headers or header values, is retained.
        const mime = response.headers()["content-type"]?.split(";")[0].trim();
        if (mime && /^[\w.+-]+\/[\w.+-]+$/.test(mime)) row.mimeType = clip(mime, 100);
      },
      requestfinished: request => {
        const row = this.requests.get(request);
        if (row) { row.state = "finished"; row.durationMs = Math.max(0, Date.now() - row.time); }
      },
      requestfailed: request => {
        const row = this.requests.get(request);
        if (row) { row.state = "failed"; row.durationMs = Math.max(0, Date.now() - row.time); }
      },
    };
    for (const [event, listener] of Object.entries(this.listeners)) page.on(event, listener);
  }

  close() {
    this.active = false;
    for (const [event, listener] of Object.entries(this.listeners)) this.page.off(event, listener);
  }

  clear() {
    this.rows.length = 0; this.dropped = 0; this.requests = new WeakMap(); this.since = new Date().toISOString();
  }

  result(options) {
    const metadata = { capturing: this.active, capturingSince: this.since, capacity: 200, dropped: this.dropped,
      note: "Only requests after capture started; credentials/query/fragment, headers and bodies are not recorded." };
    if (options.action === "details") {
      const row = this.rows.find(row => row.id === options.requestId);
      if (!row) throw new Error("Request unavailable. List captured requests; old entries expire at capacity or idle detach.");
      return { ...metadata, request: { ...row } };
    }
    const query = (options.query || "").toLowerCase();
    const rows = this.rows.filter(row => row.id > (options.afterId || 0) && (!query || row.url.toLowerCase().includes(query))
      && (!options.errorsOnly || row.state === "failed" || row.status >= 400)
      && (options.includeStatic || ["fetch", "xhr", "document"].includes(row.type) || row.state === "failed" || row.status >= 400));
    const batch = rows.slice(0, options.limit || 10);
    return { ...metadata, requests: batch.map(({ id, method, url, type, status, state }) => ({ id, method, url, type, ...(status !== undefined ? { status } : {}), state })),
      ...(rows.length > batch.length ? { nextAfterId: batch.at(-1).id, remaining: rows.length - batch.length } : {}) };
  }
}
