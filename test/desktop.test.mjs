import test from "node:test";
import assert from "node:assert/strict";
import { jsonValue } from "../src/output.js";
import { geometry, checkCoordinates, controlPage, resolveElement, refusedBeforeInput } from "../src/apps/desktop.js";
import { typingSteps } from "../src/apps/typing.js";
import { projectMcpResult } from "../src/apps/runtime.js";

test("tool values round-trip through strict JSON, including discovery optionals", () => {
  const shared = { optional: undefined, number: NaN, big: 9007199254740993n };
  const data = { shared, again: shared, list: [undefined, Infinity] }; data.self = data;
  const result = jsonValue(data);
  assert.deepEqual(result, JSON.parse(JSON.stringify(result)));
  assert.deepEqual(result.shared, result.again);
  assert.equal(result.shared.big, "9007199254740993"); assert.equal(result.self, null);
  assert.ok(!Object.hasOwn(result.shared, "optional"));
});

test("minimized HWND sentinel is rejected even when DWM/UIA reports normal bounds", () => {
  const app = { windowId: "6229110", x: 394, y: 114, width: 1393, height: 817, inputX: -32000, inputY: -32000 };
  const state = geometry(app, { window_bounds: { x: 394, y: 114, w: 1393, h: 817 }, screenshot_width: 1280, screenshot_height: 750 });
  assert.equal(state.minimized, true);
  assert.throws(() => checkCoordinates({ x: 641, y: 421 }, state, state), /sentinel/);
  const visible = geometry({ ...app, inputX: 394, inputY: 114 }, { screenshot_width: 1280, screenshot_height: 750 });
  const coords = checkCoordinates({ x: 640, y: 375 }, visible, visible);
  assert.equal(coords.points[0].screen_x, 1091);
  assert.equal(coords.points[0].screen_y, 523);
  assert.throws(() => checkCoordinates({ x: 1280, y: 1 }, visible, visible), /outside/);
  assert.throws(() => checkCoordinates({ x: 10, y: 10 }, { ...visible, bounds: { ...visible.bounds, width: 1000 } }, visible), /resized/);
  assert.equal(geometry({ x: -1920, y: 0 }).minimized, false, "negative monitor origins are valid");
});

const state = { snapshot_id: "s0000000d", elements: Array.from({ length: 147 }, (_, i) => ({ element_index: i, element_token: `s0000000d:${i}`, role: "Button", label: `Button ${i}` })) };
test("large trees keep usable structured handles independently of text truncation", async () => {
  const result = await projectMcpResult({ structuredContent: state, content: [{ type: "text", text: "tree".repeat(4000) }] }, "unused", 400);
  assert.equal(result.state.snapshot_id, "s0000000d");
  assert.equal(result.state.controls[0].element_token, "s0000000d:0");
  assert.ok(result.state.next_offset > 0 && result.state.next_offset < 147);
  const next = controlPage(state, result.state.next_offset, 400);
  assert.equal(next.snapshot_id, "s0000000d");
  assert.equal(next.controls[0].element_index, result.state.next_offset);
});

test("JSON-only driver trees are projected once and leave room for distinct commentary", async () => {
  const result = await projectMcpResult({ content: [
    { type: "text", text: JSON.stringify(state, null, 2) },
    { type: "text", text: "Inspection complete." },
  ] }, "unused", 2400);
  assert.deepEqual(result.content, [{ type: "text", text: "Inspection complete." }]);
  assert.equal(result.state.controls[0].element_token, "s0000000d:0");
  assert.ok(result.state.next_offset > 0 && result.state.next_offset < state.elements.length);
  assert.equal(controlPage(state, result.state.next_offset, 2400).controls[0].element_index, result.state.next_offset);
  assert.ok(JSON.stringify(result).length < 2400);
});

test("driver action evidence and delivery remain available for failed input", async () => {
  const action = { effect: "partial", route: "synthetic_events", delivery: { delivered_count: 1 }, evidence: { changed: false }, escalation: { reason: "background_unavailable" } };
  const result = await projectMcpResult({ isError: true, structuredContent: action, content: [] }, "unused");
  assert.deepEqual(result.action, action);
  assert.equal(result.isError, true);
});

test("stable element lookup and numeric indices use the actual driver snapshot", () => {
  const args = resolveElement({ element: { role: "Button", name: "Button 13" } }, state, {});
  assert.equal(args.element_token, "s0000000d:13");
  assert.equal(resolveElement({ element_index: 13 }, state, { snapshot_id: {} }).snapshot_id, "s0000000d");
  assert.throws(() => resolveElement({ element: { role: "Button" } }, state, {}), /147/);
  assert.throws(() => resolveElement({ element_token: "s0000000c:13" }, state, {}), /not in this snapshot/);
  assert.throws(() => resolveElement({ element_index: 13, snapshot_id: "sb3df6ec0" }, state, { snapshot_id: {} }), /never derive/);
});

test("typing exposes text+Enter, key chords and explicit pixel typing without inventing driver parameters", () => {
  const steps = typingSteps({ text: "Isaac", keys: ["Enter"], element_token: "s0000000d:13" });
  assert.deepEqual(steps.map(s => s.tool), ["type_text", "press_key"]);
  assert.equal(steps[1].arguments.key, "Enter");
  assert.deepEqual(typingSteps({ keys: ["ctrl", "a"] })[0], { tool: "hotkey", arguments: { keys: ["ctrl", "a"] } });
  assert.equal(typingSteps({ mode: "keys", text: "中文", x: 20, y: 30 })[0].arguments.text, "中文");
  assert.throws(() => typingSteps({ mode: "keys", text: "x", element_index: 1 }), /omit the UIA/);
});

test("only proven pre-input refusals are safe; unknown/partial effects stay uncertain", () => {
  assert.equal(refusedBeforeInput({ isError: true, structuredContent: { effect: "refused" } }), true);
  assert.equal(refusedBeforeInput({ structuredContent: { effect: "refused", delivery: { delivered_count: 1 } } }), false);
  assert.equal(refusedBeforeInput({ isError: true, content: [{ type: "text", text: "Background delivery is not available for target window class 'SDL_app'" }] }), true);
  assert.equal(refusedBeforeInput({ isError: true, content: [{ type: "text", text: "timeout" }] }), false);
  assert.equal(refusedBeforeInput({ structuredContent: { effect: "unverifiable" } }), false);
});
