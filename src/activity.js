import { randomUUID } from "node:crypto";
import { installActivity } from "../extension/activity.js";

export async function browserActivity(bridge, ref, controller) {
  const cdp = bridge.cdp(ref);
  const binding = `__dshStop_${randomUUID().replaceAll("-", "")}`;
  const world = `dsh-activity-${randomUUID()}`;
  let contextId;
  const stop = event => {
    if (event.name === binding && event.executionContextId === contextId && event.payload === '{"action":"stop"}') controller.abort(new Error("Stopped from the page's DSH control"));
  };
  cdp.on("Runtime.bindingCalled", stop);
  const close = async () => {
    cdp.off("Runtime.bindingCalled", stop);
    if (contextId !== undefined) await cdp.send("Runtime.evaluate", { contextId, expression: "window.__dshActivity?.close()" }).catch(() => {});
    await cdp.send("Runtime.removeBinding", { name: binding }).catch(() => {});
    await cdp.detach();
  };
  try {
    await cdp.send("Runtime.enable");
    const { frameTree } = await cdp.send("Page.getFrameTree");
    ({ executionContextId: contextId } = await cdp.send("Page.createIsolatedWorld", { frameId: frameTree.frame.id, worldName: world }));
    await cdp.send("Runtime.addBinding", { name: binding, executionContextName: world });
    const result = await cdp.send("Runtime.evaluate", { contextId, expression: `(${installActivity})(${JSON.stringify(binding)})` });
    if (result.exceptionDetails) throw new Error("Could not show browser stop controls");
    return { close, async pulse(target, signal) {
      const box = await target.boundingBox({ timeout: 500, signal });
      if (box) await cdp.send("Runtime.evaluate", { contextId, expression: `window.__dshActivity?.pulse(${JSON.stringify(box)})` });
    } };
  } catch (error) { await close(); throw error; }
}
