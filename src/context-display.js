// Display transformations only: the original text remains the serialized model payload.
export const contextRule = {
  id: "doyourweb-context", order: 5,
  match(text, from) {
    const pattern = /<(browser_context|doyourweb_context|doyourweb_annotation|doyourweb_log)>[\s\S]*?<\/\1>|@\[([^\]\n]+)\]\((dsh-(?:browser|app):\/\/[^)\s]+)\)/g;
    pattern.lastIndex = from;
    const match = pattern.exec(text);
    if (!match) return;
    const titles = { browser_context: "网页上下文", doyourweb_context: "应用上下文", doyourweb_annotation: "页面批注", doyourweb_log: "诊断日志" };
    return { id: this.id, start: match.index, end: pattern.lastIndex,
      data: { label: match[2] || titles[match[1]], kind: match[1] || "reference", text: match[0] } };
  },
};

export function insertDraftReference(conversation, sessionId, reference) {
  const shell = conversation.input.shell(sessionId);
  const state = shell.state.getSnapshot();
  const end = shell.projection.detectText.length;
  if (!shell.insertReference(reference, { start: end, end, draftRev: state.draftRev })) return false;
  shell.actions.persistDraft();
  return true;
}
