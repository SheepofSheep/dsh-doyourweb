import { randomUUID } from "node:crypto";
import { sessionWebUrl } from "../extension/protocol.js";
import { clip } from "./output.js";

export class SessionBrowserAccess {
  constructor(bridge) {
    this.bridge = bridge;
    this.sessions = new Map();
    this.onInventory = profileId => {
      const profile = bridge.profiles.get(profileId);
      for (const [sessionId, scope] of this.sessions) {
        if (scope.profile !== profileId) continue;
        if (!profile?.windows.has(scope.windowId)) this.clear(sessionId);
        else for (const [ref, grant] of scope.grants) {
          const tab = profile.tabs.get(grant.tabId);
          if (!this.eligible(scope, tab)) {
            grant.controller.abort(new Error("The browser tab left the authorized window or web pages"));
            scope.grants.delete(ref);
          }
        }
      }
    };
    bridge.on("inventoryChanged", this.onInventory);
  }

  close() {
    this.bridge.off("inventoryChanged", this.onInventory);
    for (const sessionId of this.sessions.keys()) this.clear(sessionId);
  }

  clear(sessionId) {
    const scope = this.sessions.get(sessionId);
    this.sessions.delete(sessionId);
    scope?.controller.abort(new Error("Browser access for this conversation changed"));
    for (const grant of scope?.grants.values() || []) grant.controller.abort(scope.controller.signal.reason);
  }

  state(sessionId) {
    const windows = this.bridge.accessWindows();
    const scope = this.sessions.get(sessionId);
    if (!scope || !windows.some(window => window.profile === scope.profile && window.windowId === scope.windowId)) return { enabled: false, windows };
    return { enabled: scope.enabled, profile: scope.profile, windowId: scope.windowId, windows };
  }

  set({ sessionId, enabled, profile, windowId }) {
    if (!sessionId || typeof enabled !== "boolean" || (profile === undefined) !== (windowId === undefined)) {
      throw new Error("Choose a browser window for the current conversation");
    }
    if ((profile !== undefined || enabled) && !this.bridge.profiles.get(profile)?.windows.has(windowId)) {
      throw new Error("The selected browser window is unavailable. Connect or update the DoYourWeb extension.");
    }
    const before = this.sessions.get(sessionId);
    if (!before || before.enabled !== enabled || before.profile !== profile || before.windowId !== windowId) {
      this.clear(sessionId);
      if (profile !== undefined) this.sessions.set(sessionId, { enabled, profile, windowId, grants: new Map(), controller: new AbortController() });
    }
    return this.state(sessionId);
  }

  get(sessionId) { return this.sessions.get(sessionId)?.grants; }

  eligible(scope, tab) {
    return tab?.windowId === scope.windowId && !!sessionWebUrl(tab.url, this.bridge.port);
  }

  async authorize(kind, value, { agent, signal }, ask) {
    const scope = this.sessions.get(agent.session.id);
    const profile = scope?.enabled ? this.bridge.profiles.get(scope.profile) : undefined;
    if (!profile?.windows.has(scope.windowId)) {
      throw new Error("Ask the user to enable browser access in the Browser sidebar and choose a connected browser window for this conversation. They can also select an existing tab with @.");
    }
    const scopeSignal = scope.controller.signal;
    signal = signal ? AbortSignal.any([signal, scopeSignal]) : scopeSignal;
    signal.throwIfAborted();
    let tab;
    if (kind === "open") {
      const url = sessionWebUrl(value, this.bridge.port);
      if (!url) throw new Error("browser_open requires a regular HTTP/HTTPS URL without credentials or a DoYourWeb management address");
      tab = await this.bridge.openTab(profile, scope.windowId, url.href);
    } else {
      const keywords = value.trim().normalize("NFKC").toLowerCase().split(/\s+/);
      const candidates = [...profile.tabs.values()].filter(tab => {
        if (!this.eligible(scope, tab)) return false;
        const text = `${tab.title || ""} ${tab.url}`.normalize("NFKC").toLowerCase();
        return keywords.every(keyword => text.includes(keyword));
      });
      if (!candidates.length) return { status: "no_match", message: "No matching web page in the selected window. Try the page's title or site name, or ask the user to select it with @." };
      if (candidates.length > 6) return { status: "refine", message: "Too many matching tabs. Use a more specific page title or site name." };
      if (!ask) return { status: "use_reference", message: "Native tab confirmation is unavailable. Ask the user to select the tab with @." };
      const id = randomUUID();
      const choices = candidates.map((tab, index) => ({
        label: `${index + 1}. ${clip(tab.title || new URL(tab.url).hostname, 120)}`,
        description: clip(tab.url, 200),
      }));
      let answer;
      try {
        answer = await ask({ agent, signal, questions: [{ id, header: "选择网页", question: "允许本会话访问哪个标签页？",
          options: [...choices, { label: "不授权" }] }] });
      } catch (error) {
        signal.throwIfAborted();
        if (!["NO_PROVIDER", "DELEGATED_CALLER"].includes(error.code)) throw error;
        return { status: "use_reference", message: "Native tab confirmation is unavailable. Ask the user to select the tab with @." };
      }
      signal.throwIfAborted();
      const selected = answer?.answers?.find(answer => answer.id === id)?.selected;
      const index = selected?.length === 1 ? choices.findIndex(choice => choice.label === selected[0]) : -1;
      if (index < 0) return { status: "denied" };
      const shown = candidates[index];
      const current = await this.bridge.request(profile, "dsh.tabState", [shown.id]);
      signal.throwIfAborted();
      tab = profile.tabs.get(shown.id);
      if ([current, tab].some(tab => tab?.url !== shown.url || tab?.title !== shown.title
        || tab?.windowId !== scope.windowId || tab?.revision !== shown.revision)) {
        return { status: "changed", message: "The selected tab changed during confirmation. Ask for a fresh selection." };
      }
    }
    signal.throwIfAborted();
    if (this.bridge.profiles.get(scope.profile) !== profile || !this.eligible(scope, tab)) {
      throw new Error("The browser tab or selected window changed. Check DoYourWeb before retrying.");
    }
    if (!scope.grants.has(tab.ref)) {
      const controller = new AbortController();
      scope.grants.set(tab.ref, { tabId: tab.id, controller, signal: controller.signal, assertUrl: value => {
        controller.signal.throwIfAborted();
        if (!sessionWebUrl(value, this.bridge.port)) throw new Error("Browser access in this conversation is limited to regular HTTP/HTTPS pages without credentials");
      } });
    }
    return { status: "authorized", tab: tab.ref, title: clip(tab.title || "", 128), url: clip(tab.url, 512) };
  }
}
