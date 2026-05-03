import type Database from "better-sqlite3";
import * as q from "../db/queries";

export function buildContextResponse(db: Database.Database) {
  const snap = q.getFullSnapshot(db);
  const workspaces = snap.workspaces.map((w) => ({ id: w.id, name: w.name }));
  const projects = snap.projects
    .filter((p) => !p.archivedAt)
    .map((p) => ({
      id: p.id,
      name: p.name,
      status: p.status,
      priority: p.priority,
      workspaceId: p.workspaceId,
      columns: snap.columns
        .filter((c) => c.projectId === p.id)
        .sort((a, b) => a.order - b.order)
        .map((c) => ({ id: c.id, name: c.name, type: c.type })),
    }));
  return {
    workspaces,
    projects,
    tools: {
      read: [
        "get_cairn_context", "get_active_context", "get_project_context_pack",
        "resolve_project", "get_project_summary", "list_recent_activity",
        "get_note", "list_notes", "search_notes",
        "get_task", "list_tasks", "list_ready_tasks", "search_tasks",
        "get_idea_flow", "get_idea_flow_rules",
        "get_knowledge_graph", "get_neighbors",
        "get_dashboard_constants",
      ],
      write: [
        "create_project", "update_project",
        "create_note", "import_note_from_file", "ensure_note",
        "append_to_note", "patch_note", "update_note", "move_note",
        "create_task", "update_task", "update_task_status", "bulk_update_task_status",
        "link_note_to_task", "block_task", "unblock_task",
        "create_dashboard", "update_dashboard",
        "create_idea_flow_node", "update_idea_flow_node", "create_idea_flow_edge",
        "create_tag",
      ],
      delete: ["delete_note", "delete_task", "delete_project", "delete_idea_flow_node", "delete_idea_flow_edge"],
    },
    conventions: {
      notes: "Raw markdown in 'content'. 'content_text' is auto-derived — do not set manually. Use the optional 'folder' parameter in create_note / ensure_note to place a note in a subfolder, e.g. folder=\"Design/Typography\". list_notes returns 'folder' on each note so you can see the current structure.",
      dashboards: "Use create_dashboard to create a live HTML dashboard rendered in a sandboxed iframe. Always fetch data via window.cairn helpers — never bake in static data.",
      tasks: "Always provide columnId (not just projectId) when creating a task. Use list_ready_tasks instead of list_tasks when you want to know what work can start now — it filters out tasks blocked by unresolved dependencies.",
      dependencies: "Use block_task to mark a task as blocked by another (same project only). Circular dependencies are rejected. When a blocker is moved to a done column or archived it is automatically treated as resolved. Use unblock_task to remove a dependency explicitly.",
      priority: ["low", "medium", "high", "urgent"],
      projectStatus: ["active", "on_hold", "completed", "archived"],
      columnTypes: ["backlog", "todo", "in_progress", "review", "done", "custom"],
      createProject: "create_project auto-creates 5 default columns — no need to create them separately.",
    },
  };
}
