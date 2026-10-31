/** Which note or task a Cairn tool result points at, so the UI can link it. */

const NOTE_TOOLS = new Set([
  "get_note", "ensure_note", "patch_note", "append_to_note", "rename_note", "instantiate_template", "create_note",
  "edit_note", "update_notes",
]);
const TASK_TOOLS = new Set([
  "get_task", "create_task", "update_task", "update_task_status", "claim_task", "add_task_progress",
  "update_tasks", "task_progress",
]);

/** `type` ("note" | "task") from a get_item result, or undefined. */
function getItemType(output: unknown): string | undefined {
  try {
    const parsed = typeof output === "string" ? JSON.parse(output) : output;
    return typeof parsed?.type === "string" ? parsed.type : undefined;
  } catch {
    return undefined;
  }
}

export function extractCairnRef(
  toolName: string,
  output: unknown,
): { type: "note" | "task"; id: string; title: string } | undefined {

  if (!output) return undefined;
  // get_item reads a note OR a task; its result says which.
  const itemType = toolName === "get_item" ? getItemType(output) : undefined;
  const isNote = NOTE_TOOLS.has(toolName) || itemType === "note";
  const isTask = TASK_TOOLS.has(toolName) || itemType === "task";
  if (!isNote && !isTask) return undefined;
  try {
    const parsed = typeof output === "string" ? JSON.parse(output) : output;
    const refId = parsed?.id;
    const refTitle = parsed?.title ?? parsed?.name ?? "(untitled)";
    if (!refId) return undefined;
    return { type: isNote ? "note" : "task", id: String(refId), title: String(refTitle) };
  } catch {
    return undefined;
  }
}
