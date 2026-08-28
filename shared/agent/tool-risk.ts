/**
 * Canonical agent-tool risk taxonomy — the SINGLE source of truth consumed by
 * BOTH the main-process approval classifier (cairnApprovalPlugin) and the
 * renderer's approval card. Before this module the two halves kept divergent
 * hand-maintained lists and drifted (e.g. `str_replace_editor` was gated by
 * main but labelled READ / no-grant in the UI; Cairn note/task deletes showed
 * as reads). See docs/approval-gating-audit.md §3 G7.
 *
 * Pure data + pure functions: no Electron, no Node APIs — importable from the
 * renderer, the main process, and unit tests unchanged.
 */

export type RiskClass = "READ" | "WRITE_LOCAL" | "EXEC" | "EXTERNAL";
export type GrantScope = "none" | "command" | "session";

/**
 * Tools that never need approval — read-only over Cairn data, codebase, or the
 * skill catalog, plus the pure-communication forms. Anything NOT in this set
 * routes through the approval seam when auto-approve is off.
 */
export const APPROVAL_SAFE_TOOLS = new Set<string>([
  "read", "read_image", "glob", "grep", "plan", "exit_plan_mode",
  "get_active_context", "get_cairn_context", "get_project_context_pack",
  "get_user_writing_style", "get_dashboard_constants",
  "get_note", "search_notes", "search_notes_semantic", "search_tasks_semantic",
  "get_task", "search_tasks", "list_ready_tasks", "list_overdue_tasks",
  "list_tasks_due", "list_templates", "list_folders",
  "get_neighbors", "get_semantic_neighbors", "get_idea_flow",
  "get_idea_flow_rules", "get_knowledge_graph",
  "codebase_search_symbols", "codebase_get_symbol_definition",
  "codebase_get_references", "codebase_get_file_symbols",
  "ask_questions", "skill",
]);

/** Mutating Cairn-data tools (notes/tasks/tags/boards/dashboards/idea flow). */
const CAIRN_WRITE_TOOLS = new Set<string>([
  // create_note was removed — the actual tool is ensure_note (create-or-update).
  "ensure_note", "patch_note", "append_to_note", "rename_note",
  "delete_note", "bulk_move_notes", "instantiate_template",
  "create_task", "update_task", "delete_task", "bulk_update_task_status",
  "spawn_tasks_from_note", "link_note_to_task", "unlink_note_from_task",
  "tag_note", "tag_task", "create_tag", "upsert_project", "delete_project",
  "create_dashboard", "update_dashboard",
  "create_idea_flow_node", "update_idea_flow_node",
  "create_idea_flow_edge", "delete_idea_flow_edge", "delete_idea_flow_node",
  // layout_idea_flow rewrites node x/y for every node in a flow → mutating.
  // codebase_reindex writes the local semantic index → mutating (local data).
  "layout_idea_flow", "codebase_reindex",
  "generate_prd", "suggest_connections",
]);

/** Mutating dsh coding-stack tools (fs/editor/todo). bash is EXEC, not here. */
const DSH_WRITE_TOOLS = new Set<string>(["write", "edit", "str_replace_editor", "todo_write"]);

/** Does this call need the user's approval before it runs? */
export function needsApproval(name: string): boolean {
  return !APPROVAL_SAFE_TOOLS.has(name);
}

/**
 * Args-aware approval gate. Identical to `needsApproval` except it recognises
 * read-only invocations of multiplexed tools: `str_replace_editor` with
 * `command:"view"` only reads a file, so it should not prompt (its
 * create/str_replace/insert commands still do). Falls back to the name-only
 * gate for every other tool. Both the main-process gate and the renderer card
 * use this so they never diverge.
 */
export function needsApprovalForCall(name: string, args: Record<string, unknown> = {}): boolean {
  if (name === "str_replace_editor" && args.command === "view") return false;
  return needsApproval(name);
}

export function riskForTool(name: string): RiskClass {
  if (/^(?:mcp|svc)__/.test(name)) return "EXTERNAL";
  if (name === "bash") return "EXEC";
  // `subagent` (dsh-tool-subagent, registered under toolName "subagent") spawns
  // an in-process child agent that inherits the coding tool stack — including
  // bash/fs/editor — so it reaches the shell and is EXEC-class, not a local
  // write. The old `spawn_subagent` name matched nothing the runtime registers,
  // so the real tool silently fell through to WRITE_LOCAL and was offered a
  // standing "session" grant (understating a shell-capable delegation).
  if (name === "subagent") return "EXEC";
  if (CAIRN_WRITE_TOOLS.has(name) || DSH_WRITE_TOOLS.has(name)) return "WRITE_LOCAL";
  if (APPROVAL_SAFE_TOOLS.has(name)) return "READ";
  // Unknown tool — label conservatively. The classifier independently defaults
  // to asking (needsApproval is set-membership, so an unlisted tool always asks).
  return "WRITE_LOCAL";
}

export function approvalPreview(name: string, args: Record<string, unknown> = {}): string {
  const value = name === "bash"
    ? args.command
    : name === "write"
      ? args.content
      : name.startsWith("mcp__") || name.startsWith("svc__")
        ? JSON.stringify(args, null, 2)
        : args.path ?? args.title ?? args.query ?? "";
  const text = typeof value === "string" ? value : (JSON.stringify(value, null, 2) ?? "");
  const lines = text.split("\n").slice(0, 5);
  const clamped = lines.join("\n").slice(0, 420);
  return clamped + (clamped.length < text.length ? "…" : "");
}

/**
 * Which "always allow" grant the approval card offers for a tool:
 *
 * - `command` — bash only: bind the standing grant to this exact command.
 * - `session` — writes and external calls: allow this tool for the session.
 * - `none`    — reads and other exec: one-off allow/deny only, no standing grant.
 */
export function approvalGrantScope(name: string): GrantScope {
  const risk = riskForTool(name);
  if (risk === "EXEC" && name === "bash") return "command";
  if (risk !== "READ" && risk !== "EXEC") return "session";
  return "none";
}

/** Where an action reaches, for the approval card's one-line scope note. */
export function approvalScopeLabel(name: string): string {
  const risk = riskForTool(name);
  // "this device" rather than "this Mac" — Cairn ships on Windows and Linux too.
  if (risk === "EXTERNAL") return "leaves this device via a connected service";
  if (risk === "EXEC") return "runs on this device";
  return "stays on this device";
}
