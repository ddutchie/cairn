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
      read: ["get_cairn_context", "get_active_context", "get_note", "get_task", "list_notes", "list_tasks", "search_notes", "search_tasks", "get_project_summary"],
      write: ["create_project", "create_note", "update_note", "create_task", "update_task", "update_task_status", "link_note_to_task", "create_dashboard", "update_dashboard"],
      delete: ["delete_note", "delete_task"],
    },
    conventions: {
      notes: "Raw markdown in 'content'. 'content_text' is auto-derived — do not set manually.",
      dashboards: "Use create_dashboard to create a live HTML dashboard rendered in a sandboxed iframe. Always fetch data via window.cairn helpers — never bake in static data.",
      tasks: "Always provide columnId (not just projectId) when creating a task.",
      priority: ["low", "medium", "high", "urgent"],
      projectStatus: ["active", "on_hold", "completed", "archived"],
      columnTypes: ["backlog", "todo", "in_progress", "review", "done", "custom"],
      createProject: "create_project auto-creates 5 default columns — no need to create them separately.",
    },
  };
}
