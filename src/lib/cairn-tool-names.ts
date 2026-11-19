/**
 * Cairn's own managed data tools (notes, tasks, projects, idea flow, graph,
 * writing style, Today). The transcript renders these through the shared tool
 * card, the way connector calls are. Older per-operation names stay so replayed
 * transcripts keep their card.
 */
const CURRENT = [
  "get_context", "get_item", "search_notes", "search_tasks", "ensure_note", "edit_note", "update_notes",
  "create_task", "update_tasks", "task_progress", "upsert_project", "delete", "get_idea_flow", "edit_idea_flow",
  "get_graph", "get_user_writing_style", "update_user_writing_style", "get_today", "codebase_reindex",
  "codebase_query", "suggest_connections", "spawn_tasks_from_note", "people",
];
const LEGACY = [
  "create_note", "get_note", "patch_note", "append_to_note", "rename_note", "delete_note", "tag_note", "bulk_move_notes",
  "create_task", "get_task", "update_task", "delete_task", "tag_task", "bulk_update_task_status", "link_note_to_task",
  "unlink_note_from_task", "delete_project", "create_tag", "create_idea_flow_node", "update_idea_flow_node",
  "delete_idea_flow_node", "create_idea_flow_edge", "delete_idea_flow_edge", "layout_idea_flow", "generate_prd",
  "instantiate_template", "update_dashboard", "create_dashboard", "today_read", "today_upsert", "today_remove", "today_finish",
];

const CAIRN_TOOLS = new Set<string>([...CURRENT, ...LEGACY]);

export function isCairnTool(name: string): boolean {
  return CAIRN_TOOLS.has(name);
}
