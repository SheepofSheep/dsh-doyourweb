// browserTabs/list only reads the bridge's in-memory inventory; it never reads a page.
// Share one watcher between the open input menu and the mounted webpage pane.
export function browserTabChanges(service, lifetime) {
  const listeners = new Set();
  let timer, controller, snapshot, busy = false;
  const poll = async () => {
    if (busy || !listeners.size) return;
    const current = controller;
    busy = true;
    let next;
    try {
      const result = await service().list({}, current.signal);
      next = result.ok ? JSON.stringify([result.value.connected, result.value.tabs.map(tab =>
        [tab.ref, tab.title, tab.url, tab.browser])]) : "unavailable";
    } catch { next = "unavailable"; }
    finally { busy = false; }
    if (current.signal.aborted || next === snapshot) return;
    snapshot = next;
    for (const listener of [...listeners]) listener();
  };
  return (listener, signal) => {
    if (signal.aborted || lifetime?.aborted) return () => {};
    const notify = () => listener();
    listeners.add(notify);
    const stop = () => {
      signal.removeEventListener("abort", stop);
      lifetime?.removeEventListener("abort", stop);
      if (!listeners.delete(notify)) return;
      if (listeners.size) return;
      clearInterval(timer); controller.abort();
      globalThis.window?.removeEventListener?.("focus", poll);
    };
    signal.addEventListener("abort", stop, { once: true });
    lifetime?.addEventListener("abort", stop, { once: true });
    if (listeners.size === 1) {
      controller = new AbortController();
      timer = setInterval(poll, 1000);
      globalThis.window?.addEventListener?.("focus", poll);
      void poll();
    }
    return stop;
  };
}
