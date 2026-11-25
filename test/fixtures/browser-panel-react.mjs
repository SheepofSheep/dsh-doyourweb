// Minimal hook runtime for exercising BrowserPanel outside the DSH host.
const state = [];
const effects = [];
let hookIndex = 0;

export function beginRender() {
  hookIndex = 0;
  effects.length = 0;
}

export function collectEffects() {
  return effects.filter(Boolean);
}

export function createElement(type, props, ...children) {
  return { type, props: { ...(props || {}), children: children.length === 1 ? children[0] : children } };
}

export function useState(initial) {
  const index = hookIndex++;
  if (!(index in state)) state[index] = typeof initial === "function" ? initial() : initial;
  return [state[index], value => { state[index] = typeof value === "function" ? value(state[index]) : value; }];
}

export function useEffect(effect) {
  effects[hookIndex++] = effect;
}
