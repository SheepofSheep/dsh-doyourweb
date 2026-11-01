// Append through DSH's input shell so existing text, reference chips and attachments survive.
export function appendAnnotationDraft(conversation, request) {
  const shell = conversation?.input?.shell?.(request.sessionId);
  if (!shell?.actions?.insertText) throw new Error("当前 DSH 版本没有可用的聊天草稿接口");
  const state = shell.state.getSnapshot();
  if (["submitting", "adjudicating"].includes(state.phase)) return false;
  const text = request.content.filter(item => item.type === "text").map(item => item.text).join("\n");
  const files = request.content.filter(item => item.type === "image").map(item => new File([
    Uint8Array.from(atob(item.data), char => char.charCodeAt(0)),
  ], item.name || "页面批注.png", { type: item.mediaType }));
  const attachments = files.length ? conversation.createDrafts(request.sessionId, files) : [];
  const ids = attachments.map(item => item.id);
  try {
    if (ids.length && !shell.actions.addAttachments(ids)) return false;
    // Reference chips occupy one detect-coordinate character, even when their clipboard text is long.
    const end = shell.projection.detectText.length;
    const wrapped = `<doyourweb_annotation>\n${text}\n</doyourweb_annotation>`;
    const span = { start: end, end, draftRev: state.draftRev };
    const inserted = shell.insertReference
      ? shell.insertReference({ source: "doyourweb-context", ref: wrapped, label: "页面批注", appearance: "file", clipboardText: wrapped }, span)
      : shell.actions.insertText(`${end ? "\n\n" : ""}${text}\n`, span);
    if (!inserted) {
      for (const id of ids) shell.actions.removeAttachment(id);
      return false;
    }
    shell.actions.persistDraft();
    return true;
  } finally {
    const retained = shell.state.getSnapshot().attachmentIds;
    for (const id of ids) if (!retained.includes(id)) conversation.releaseDraftAttachment(id);
  }
}
