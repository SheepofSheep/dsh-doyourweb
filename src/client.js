import { formatMention, remoteContribution } from "./protocol.js";
import { compactReferences, referenceQuery } from "./reference-folders.js";
import { browserTabChanges } from "./browser-tab-changes.js";

// This plugin both mounts the Host-for-Client contribution and consumes it, so it
// cannot declare `remote.browserTabs` as an injected dependency (that would wait
// for a namespace this same fiber creates). Cordis refuses property access to an
// uninjected nested key — `cannot get property "remote.browserTabs" without
// inject` — so the namespace is resolved through `ctx.get()` at call time.
export const inject = ["inputTriggers", "remote"];

export function apply(ctx, { browserIcon, tabIcon, appIcon = browserIcon, applicationIcon = () => appIcon }) {
  ctx.effect(() => ctx.remote.$mount(remoteContribution));
  ctx.effect(() => compactReferences(ctx.inputTriggers));

  function setupCandidate(description) {
    return { name: "browser", label: "\u6d4f\u89c8\u5668", description,
      value: "setup", icon: browserIcon, section: "\u6d4f\u89c8\u5668" };
  }

  /** The mounted Host-for-Client Remote namespace, or a message the menu can show. */
  function namespace() {
    const service = ctx.get ? ctx.get("remote.browserTabs") : ctx.remote?.browserTabs;
    if (!service) throw new Error("browser service is not registered by the DSH host");
    return service;
  }

  const lifetime = new AbortController();
  ctx.effect(() => () => lifetime.abort());
  const watchTabs = browserTabChanges(namespace, lifetime.signal);
  const invalidations = new Set();
  const refreshCandidates = () => { for (const listener of [...invalidations]) listener(); };
  const lexicon = () => [];
  const subscribeLexicon = (_session, listener) => { invalidations.add(listener); return () => invalidations.delete(listener); };

  async function candidates({ query = "", signal }, slash = false) {
    if (signal?.aborted) return [];
    if (signal) watchTabs(refreshCandidates, signal);
    const browserQuery = query && ["browser", "\u6d4f\u89c8\u5668"].includes(query.toLowerCase());
    const matchesSetup = !query || "browser \u6d4f\u89c8\u5668".includes(query.toLowerCase());
    let result;
    try {
      result = await namespace().list({ query: browserQuery ? "" : query }, signal);
      if (!result.ok) throw new Error(result.error?.message || "Browser service is unavailable");
    } catch (error) {
      if (signal?.aborted) return [];
      return [setupCandidate(`\u670d\u52a1\u4e0d\u53ef\u7528: ${error.message}`)];
    }
    if (result.value.connected === false) return [setupCandidate("\u672a\u8fde\u63a5")];
    const tabs = result.value.tabs.map(tab => ({
      name: tab.title || tab.url,
      description: `${new URL(tab.url).protocol === "file:" ? "本地 HTML" : new URL(tab.url).hostname} - ${tab.browser}`,
      icon: tabIcon(tab), section: "\u6807\u7b7e\u9875",
      value: JSON.stringify({ ref: formatMention(tab), label: tab.title || tab.url }),
    }));
    if (slash && matchesSetup) tabs.unshift(setupCandidate("\u8fde\u63a5\u8bbe\u7f6e"));
    else if (!query && !tabs.length) tabs.push(setupCandidate("\u65e0\u53ef\u7528 HTTP/HTTPS 或本地 HTML \u6807\u7b7e\u9875"));
    return tabs;
  }

  function onPick({ candidate }) {
    if (["setup", "manage"].includes(candidate.value)) {
      let service;
      try { service = namespace(); }
      catch (error) { console.error("dsh-doyourweb", error); return { text: "" }; }
      void service[candidate.value]({}).then(result => {
        if (!result.ok) throw new Error(result.error?.message || "Browser setup is unavailable");
        window.open(result.value.url, "_blank", "noopener");
      }).catch(error => console.error("dsh-doyourweb", error));
      return { text: "" };
    }
    const value = JSON.parse(candidate.value);
    return { insert: {
      source: value.source || "browser-tabs", ref: value.ref, label: value.label,
      appearance: "file", clipboardText: value.ref,
    } };
  }

  ctx.effect(() => ctx.inputTriggers.registerSource({
    trigger: "@", name: "browser-tabs", showGroupTitle: false,
    lexicon, subscribeLexicon,
    async candidates(_session, request) {
      const { quoted, drilled } = request;
      if (quoted || drilled || referenceQuery(request.query)) return [];
      return candidates(request);
    },
    onPick,
    openReference(_session, { ref }) {
      const match = ref.match(/dsh-browser:\/\/[a-z0-9-]+\/\d+/i);
      let service;
      if (!match) return false;
      try { service = namespace(); } catch { return false; }
      void service.focus({ ref: match[0] }).catch(error => console.error("dsh-doyourweb", error));
      return true;
    },
    codec: { clipboardText: ref => ref, serialize: async ref => ref },
  }));
  ctx.effect(() => ctx.inputTriggers.registerSource({
    trigger: "/", name: "browser-setup", showGroupTitle: false,
    lexicon, subscribeLexicon,
    candidates: (_session, request) => candidates(request, true),
    onPick,
  }));
  for (const [method, source, section] of [["apps", "desktop-apps", "应用程序"]]) {
    ctx.effect(() => ctx.inputTriggers.registerSource({
      trigger: "@", name: source, showGroupTitle: false,
      async candidates(_session, request) {
        if (request.quoted || request.drilled || referenceQuery(request.query)) return [];
        const query = request.query || "";
        try {
          const result = await namespace()[method]({ query: ["应用", "程序", "apps"].includes(query.toLowerCase()) ? "" : query }, request.signal);
          if (!result.ok || result.value.error) return [];
          return result.value[method].map(item => {
            const appName = item.displayName || item.product || item.name;
            const label = item.comment || [appName, item.title].filter(Boolean).join(" · ");
            const ref = `@[${label.replace(/[\[\]\\\r\n]/g, " ").slice(0, 128)}](${item.ref})`;
            return { name: item.comment || appName, description: item.installed && !item.windowId ? `${item.title} · 按需启动` : item.title, section, icon: applicationIcon(item),
              value: JSON.stringify({ ref, label, source }) };
          });
        } catch { return []; }
      }, onPick,
      openReference() { void namespace().manage({}).then(result => { if (result.ok) window.open(result.value.url, "_blank", "noopener"); }).catch(console.error); return true; },
      codec: { clipboardText: ref => ref, serialize: async ref => ref },
    }));
  }
  ctx.effect(() => ctx.inputTriggers.registerSource({ trigger: "/", name: "doyourweb-manage", showGroupTitle: false,
    // DSH chains .then() directly; even local candidate lists must be async.
    candidates: async (_session, { query = "" }) => !query || "apps 应用 doyourweb".includes(query.toLowerCase())
      ? [{ name: "apps", label: "应用管理", description: "连接器与安装确认", value: "manage", section: "DoYourWeb", icon: appIcon }] : [], onPick }));
  return watchTabs;
}
