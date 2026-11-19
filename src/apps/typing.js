import { z } from "zod";

export const typingSchema = z.object({
  text: z.string().max(16000).optional(),
  keys: z.array(z.string().min(1).max(40)).min(1).max(5).optional().describe("One key (Enter/Tab/Esc), or a chord such as [ctrl,a]. Sent after text."),
  mode: z.enum(["auto", "value", "keys"]).default("auto").describe("auto uses UIA for an element target, keys otherwise; value requires a UIA field; keys uses screenshot x,y or the focused field."),
  element: z.object({ role: z.string().max(100).optional(), name: z.string().max(300).optional() }).optional(),
  element_token: z.string().max(128).optional(), element_index: z.number().int().min(0).optional(),
  x: z.number().min(0).max(20000).optional(), y: z.number().min(0).max(20000).optional(),
});

export function typingSteps(input) {
  const { text, keys, mode, ...target } = typingSchema.parse(input);
  if (text === undefined && !keys) throw new Error("Provide text and/or keys, for example text:'Isaac', keys:['Enter']");
  if ((target.x === undefined) !== (target.y === undefined)) throw new Error("Typing coordinates require both x and y");
  const element = target.element || target.element_token || target.element_index !== undefined;
  if (mode === "value" && !element) throw new Error("mode:value requires element, element_token or element_index; use mode:keys for the focused field or screenshot coordinates");
  if (mode === "keys" && element) throw new Error("mode:keys uses the focused field or screenshot x,y; omit the UIA element target. Use mode:value to replace a UIA value.");
  if (element && target.x !== undefined) throw new Error("Choose a UIA element or screenshot coordinates, not both");
  const steps = [];
  if (text !== undefined) steps.push(mode === "value"
    ? { tool: "set_value", arguments: { ...target, value: text } }
    : { tool: "type_text", arguments: { ...target, text } });
  if (keys) steps.push({ tool: keys.length === 1 ? "press_key" : "hotkey", arguments: {
    ...target, ...(keys.length === 1 ? { key: keys[0] } : { keys }),
  } });
  return steps;
}
