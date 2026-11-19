import { randomUUID } from "node:crypto";
import { installActivity } from "../extension/activity.js";

export async function browserActivity(bridge, ref) {
  const cdp = bridge.cdp(ref);
  const world = `dsh-activity-${randomUUID()}`;
  let contextId;
  const close = async () => {
    if (contextId !== undefined) await cdp.send("Runtime.evaluate", { contextId, expression: "window.__dshActivity?.close()" }).catch(() => {});
    await cdp.detach();
  };
  try {
    const { frameTree } = await cdp.send("Page.getFrameTree");
    ({ executionContextId: contextId } = await cdp.send("Page.createIsolatedWorld", { frameId: frameTree.frame.id, worldName: world }));
    const result = await cdp.send("Runtime.evaluate", { contextId, expression: `(${installActivity})()` });
    if (result.exceptionDetails) throw new Error("Could not show browser activity");
    return { close };
  } catch (error) { await close(); throw error; }
}
