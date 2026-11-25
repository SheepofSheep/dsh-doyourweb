import { BrowserPanel } from "../../src/browser-panel.js";
import { beginRender, collectEffects } from "./browser-panel-react.mjs";

export function renderBrowserPanel(props) {
  beginRender();
  const tree = BrowserPanel(props);
  return { tree, effects: collectEffects() };
}
