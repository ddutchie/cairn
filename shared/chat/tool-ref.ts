/**
 * Derive a navigable note/card reference from a completed chat tool call.
 *
 * When the mobile assistant runs a tool that creates or touches a note or card,
 * its tool chip becomes tappable and opens that item by id — the reliable,
 * collision-proof path (no title matching). This module holds the pure mapping
 * from tool name → where its id lives (args vs result) → a `{ kind, id }` ref.
 *
 * Kept as framework-free logic (no React/RN) so it is unit-testable in the root
 * vitest suite. Mobile is currently the only consumer (via
 * `@cairn/shared/chat/tool-ref`); the desktop renderer and the electron chat
 * executor each derive their own refs with a different shape (`type:"task"` +
 * title, result-only sourcing), so this is intentionally NOT unified with them.
 */

/** A navigable reference the tool chip can open. */
export interface ToolRef {
  kind: "note" | "card";
  id: string;
}

/** Tools whose result/args point at a NOTE, and whether the id is in args or result. */
export const NOTE_TOOLS: Record<string, "args" | "result"> = {
  ensure_note: "result",
  create_note: "result",
  get_note: "args",
  append_to_note: "args",
  patch_note: "args",
  rename_note: "args",
  move_note_to_project: "args",
};

/** Tools whose result/args point at a CARD. */
export const CARD_TOOLS: Record<string, "args" | "result"> = {
  create_task: "result",
  get_task: "args",
  update_task: "args",
};

/** Pull a string `id` field out of an unknown args/result object. */
export function idFrom(obj: unknown): string | null {
  if (obj && typeof obj === "object" && "id" in obj) {
    const id = (obj as { id: unknown }).id;
    if (typeof id === "string" && id) return id;
  }
  return null;
}

/**
 * Derive a navigable note/card ref from a completed tool call, so the tool chip
 * can open the thing it created/touched — the reliable, id-based path (no title
 * matching). Returns undefined for read-only / non-navigable tools.
 */
export function toolRef(tool: string, args: unknown, result: unknown): ToolRef | undefined {
  // Never navigate to an errored tool.
  if (result && typeof result === "object" && "error" in (result as object)) return undefined;
  const noteWhere = NOTE_TOOLS[tool];
  if (noteWhere) {
    const id = idFrom(noteWhere === "args" ? args : result);
    if (id) return { kind: "note", id };
  }
  const cardWhere = CARD_TOOLS[tool];
  if (cardWhere) {
    const id = idFrom(cardWhere === "args" ? args : result);
    if (id) return { kind: "card", id };
  }
  return undefined;
}
