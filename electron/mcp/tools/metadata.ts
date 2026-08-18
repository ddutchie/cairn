/* eslint-disable @typescript-eslint/no-explicit-any */
import Database from "better-sqlite3";
import { Snapshot } from "../db";
import { executeGetProjectContextPack } from "../../shared/read-tools-pure";

export const DASHBOARD_CONSTANTS = {
  description: "window.cairn API for Cairn dashboards (rendered in a sandboxed iframe).",
  rules: [
    "html must be a complete self-contained document with inline CSS/JS only — no external URLs",
    "Never hardcode projectId or workspaceId — always use window.cairn.projectId and window.cairn.workspaceId",
    "Always fetch data dynamically via helpers — never bake in static data",
  ],
  helpers: {
    "window.cairn.projectId": "Active project ID (string)",
    "window.cairn.workspaceId": "Active workspace ID (string)",
    "window.cairn.getProjectSummary(projectId?)": "Returns { project, noteCount, totalCards, columns: [{ id, name, type, taskCount, tasks: [{ id, title, priority, dueDate }] }] }",
    "window.cairn.listTasks(projectId?)": "Returns { tasksByColumn: { COLUMN_ID: [{ id, title, priority, description, dueDate, columnId, columnName, columnType, updatedAt }] } }. Usage: Object.values(result.tasksByColumn).flat()",
    "window.cairn.listNotes(projectId?)": "Returns [{ id, title, projectId, isPinned, updatedAt }]",
    "window.cairn.listRecentActivity(opts?)": "Returns { recentNotes: [{ id, title, projectId, updatedAt }], recentTasks: [{ id, title, projectId, updatedAt }] }",
    "window.cairn.searchTasks(query, projectId?)": "Returns [{ id, title, priority, columnId }]",
    "window.cairn.searchNotes(query, projectId?)": "Returns [{ id, title, snippet, projectId }]",
    "window.cairn.getContext()": "Returns { workspaces, projects: [{ id, name, status, priority, columns: [{ id, name, type }] }] }",
  },
};

export const IDEA_FLOW_RULES = {
  description: "Idea Flow node types, data shapes, and group conventions.",
  nodeTypes: {
    idea:        "Free-form thought. data: { title, body }",
    note_ref:    "Links to an existing note. data: { noteId }",
    task_ref:    "Links to an existing task card. data: { cardId }",
    url:         "External reference. data: { url, title?, description? }",
    ai_summary:  "AI-generated summary. data: { content }. Do not connect edges TO this from other ai_summary nodes.",
    group:       "Spatial container. data: { label?, color? }. Do NOT connect edges to/from group nodes.",
  },
  positioning: [
    "Always call get_idea_flow first — use spatial.nextPosition as the base {x,y} for new nodes, incrementing y by ~120px per row",
    "get_idea_flow returns absoluteX/absoluteY on every node for full canvas reasoning",
  ],
  groups: [
    "Create the group node first, then create child nodes with parentId set to the group's ID",
    "Child coordinates are relative to the group's top-left corner — use spatial.groupSlots[groupId] as starting position, increment y ~100px per row",
    "layout_idea_flow runs two-phase: children arranged inside groups first, then groups + ungrouped nodes arranged together",
    "Always call layout_idea_flow after bulk-creating grouped nodes",
  ],
};

export function getCairnContext(db: Database.Database, snap: Snapshot, _args: Record<string, any>, workspacePath?: string) {
  const workspaces = snap.workspaces.map((w) => ({ id: w.id, name: w.name }));
  const projects = snap.projects
    .filter((p) => !p.archivedAt)
    .map((p) => {
      const proj: Record<string, unknown> = {
        id: p.id, name: p.name,
        workspaceId: p.workspaceId,
      };
      // Omit default values — conventions list the full enum set.
      if (p.status !== "active") proj.status = p.status;
      if (p.priority !== "medium") proj.priority = p.priority;
      const cols = snap.columns
        .filter((c) => c.projectId === p.id)
        .sort((a, b) => a.order - b.order)
        .map((c) => ({ id: c.id, name: c.name, type: c.type }));
      if (cols.length > 0) proj.columns = cols;
      return proj;
    });
  // NOTE: `tools` block was removed — MCP clients enumerate tools via `tools/list`
  // (mcp-server.ts line 42) and the agent system prompt references them directly.
  // The static list duplicated ~600 bytes of tool names per call.
  return {
    workspaces,
    projects,
    tags: snap.tags.map((t) => ({ id: t.id, name: t.name, color: t.color, workspaceId: t.workspaceId })),
    // Which files this server is actually bound to. A long-running MCP process
    // and the desktop app can end up on different workspaces (the app can swap
    // folders in place), and without this the only way to tell was `lsof`.
    runtime: {
      dbPath: db.name,
      ...(workspacePath ? { workspacePath } : {}),
    },
    conventions: {
      notes: "Raw markdown in 'content'. Plain text for search/embeddings is derived automatically — do not set any separate text field.",
      dashboards: "Use create_dashboard to create an HTML dashboard rendered in a sandboxed iframe inside Cairn. The 'html' field must be a complete, self-contained HTML document. Use inline CSS and JS only — no external URLs. The window.cairn.query(tool, args) API is available for live data from read-only tools.",
      tasks: "Always provide columnId (not just projectId) when creating a task. Use list_ready_tasks to find work that can start now — it filters out blocked tasks.",
      dependencies: "Use update_task with blockedBy to mark a task as blocked by another (same project only). Circular dependencies are rejected. When a blocker is moved to a done column or archived it is automatically treated as resolved. Use update_task with unblockFrom to remove a dependency explicitly.",
      priority: ["low", "medium", "high", "urgent"],
      projectStatus: ["active", "on_hold", "completed", "archived"],
      columnTypes: ["backlog", "todo", "in_progress", "review", "done", "custom"],
      createProject: "upsert_project without projectId auto-creates 5 default columns — no need to create them separately. Provide projectId to update an existing project.",
    },
  };
}

export function getProjectContextPack(db: Database.Database, snap: Snapshot, args: Record<string, any>) {
  return executeGetProjectContextPack(snap, args);
}
