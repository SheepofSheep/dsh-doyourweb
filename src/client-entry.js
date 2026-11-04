import { createElement, useEffect } from "react";
import { IconGlobeOutlineRegular } from "@deepseek-ai/dsh-client-ui-primitives";
import { apply as registerSources } from "./client.js";
import { appendAnnotationDraft } from "./annotation-drafts.js";
import { ObjectIcon, registerBrowserPanel } from "./browser-panel.js";

export { inject } from "./client.js";

function TabIcon({ favicon, size = 14 }) {
  return createElement(ObjectIcon, { src: favicon, size });
}

function AppIcon({ icon, size = 14 }) {
  return createElement(ObjectIcon, { src: icon, app: true, size });
}

function AnnotationSession({ sessionId, publish }) {
  useEffect(() => {
    const update = () => publish(sessionId, true);
    update(); const timer = setInterval(update, 1000);
    window.addEventListener("focus", update);
    return () => { clearInterval(timer); window.removeEventListener("focus", update); publish(sessionId, false); };
  }, [sessionId, publish]);
  return null;
}

export function apply(ctx) {
  registerSources(ctx, { browserIcon: IconGlobeOutlineRegular,
    tabIcon: tab => props => createElement(TabIcon, { ...props, favicon: tab.favicon }),
    appIcon: AppIcon, applicationIcon: app => props => createElement(AppIcon, { ...props, icon: app.icon }),
  });
  registerBrowserPanel(ctx);
  const client = crypto.randomUUID(); let revision = 0;
  const delivered = new Map(), acknowledgements = new Map(), busy = new Set();
  ctx.inject?.(["slots", "sessions"], scope => {
    const publish = async (sessionId, active) => {
      if (active && busy.has(sessionId)) return;
      const summary = scope.sessions.list.getSnapshot().byId[sessionId];
      const service = ctx.get("remote.browserTabs");
      if (!service?.annotationSession) return;
      if (active) busy.add(sessionId);
      const ack = acknowledgements.get(sessionId) || [];
      try {
        const response = await service.annotationSession({ client, revision: ++revision, sessionId, active,
          title: summary?.displayTitle || summary?.title || "当前会话", acknowledgements: ack });
        if (!response.ok) throw new Error(response.error?.message || "批注同步失败");
        acknowledgements.set(sessionId, []);
        for (const draft of response.value.drafts || []) {
          const id = draft.requestId;
          if (!delivered.has(id)) {
            if (!appendAnnotationDraft(ctx.get("conversation"), draft)) continue;
            delivered.set(id, true);
            if (delivered.size > 500) delivered.delete(delivered.keys().next().value);
          }
          acknowledgements.get(sessionId).push({ id });
        }
      } catch (error) { console.warn("dsh-doyourweb annotation draft", error); }
      finally { if (active) busy.delete(sessionId); }
    };
    scope.slots.inject("conversation.input.overlay", () => scope.slots.register({ name: "conversation.input.overlay", id: "doyourweb-annotation-session",
      inject: sessionId => ({ sessionId, publish }) }, AnnotationSession));
  });
}
