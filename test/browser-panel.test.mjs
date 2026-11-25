import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

test("BrowserPanel renders non-empty tabs without undefined authorization state", async () => {
  const result = await build({
    entryPoints: [path.join(root, "test", "fixtures", "browser-panel-render.mjs")],
    bundle: true,
    write: false,
    platform: "node",
    format: "esm",
    target: "node22",
    logLevel: "silent",
    plugins: [{
      name: "browser-panel-test-stubs",
      setup(builder) {
        builder.onResolve({ filter: /^react$/ }, () => ({
          path: path.join(root, "test", "fixtures", "browser-panel-react.mjs"),
        }));
        builder.onResolve({ filter: /^@deepseek-ai\/dsh-client-ui-primitives$/ }, () => ({
          path: path.join(root, "test", "fixtures", "browser-panel-primitives.mjs"),
        }));
      },
    }],
  });
  const bundle = result.outputFiles[0].text;
  const { renderBrowserPanel } = await import(`data:text/javascript;base64,${Buffer.from(bundle).toString("base64")}`);
  const service = () => ({
    list: async () => ({ ok: true, value: { connected: true, tabs: [{
      ref: "dsh-browser://edge/1", title: "示例网页", url: "https://example.com/", browser: "Edge", authorized: true,
    }] } }),
  });
  const props = { service, conversation: {}, sessionId: "session-1", watchTabs: undefined };
  const first = renderBrowserPanel(props);
  for (const effect of first.effects) await effect?.();
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  assert.doesNotThrow(() => renderBrowserPanel(props));
  const { tree } = renderBrowserPanel(props);
  const rendered = JSON.stringify(tree);
  assert.match(rendered, /示例网页/);
  assert.doesNotMatch(rendered, /无法载入/);
});
