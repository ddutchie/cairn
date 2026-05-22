/* eslint-disable @typescript-eslint/no-explicit-any */
import Database from "better-sqlite3";
import { Snapshot } from "../db";

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

export function getCairnContext(db: Database.Database, snap: Snapshot, _args: Record<string, any>) {
  const workspaces = snap.workspaces.map((w) => ({ id: w.id, name: w.name }));
  const projects = snap.projects
    .filter((p) => !p.archivedAt)
    .map((p) => ({
      id: p.id, name: p.name, status: p.status, priority: p.priority,
      workspaceId: p.workspaceId,
      columns: snap.columns
        .filter((c) => c.projectId === p.id)
        .sort((a, b) => a.order - b.order)
        .map((c) => ({ id: c.id, name: c.name, type: c.type })),
    }));
  return {
    workspaces,
    projects,
    tags: snap.tags.map((t) => ({ id: t.id, name: t.name, color: t.color, workspaceId: t.workspaceId })),
    tools: {
      read:   ["get_cairn_context", "get_project_context_pack", "search_notes", "search_tasks", "get_note", "get_task", "list_ready_tasks"],
      write:  ["upsert_project", "ensure_note", "append_to_note", "patch_note", "create_task", "update_task", "bulk_update_task_status", "link_note_to_task", "create_dashboard", "update_dashboard", "create_idea_flow_node", "update_idea_flow_node", "create_idea_flow_edge", "create_tag"],
      delete: ["delete_note", "delete_task", "delete_project", "delete_idea_flow_node", "delete_idea_flow_edge"],
      ideaFlow: ["get_idea_flow", "create_idea_flow_node", "update_idea_flow_node", "delete_idea_flow_node", "create_idea_flow_edge", "delete_idea_flow_edge", "layout_idea_flow"],
    },
    conventions: {
      notes: "Raw markdown in 'content'. 'content_text' is auto-derived — do not set manually.",
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
  const project = snap.projects.find((p) => p.id === args.projectId);
  if (!project) return { error: "Project not found" };
  const columns = snap.columns
    .filter((c) => c.projectId === project.id)
    .sort((a, b) => a.order - b.order);
  const notes = snap.notes.filter((n) => n.projectId === project.id && !n.archivedAt);
  const pinnedNotes = notes
    .filter((n) => n.isPinned)
    .map((n) => ({ id: n.id, title: n.title, content: n.content }));
  const openCards = columns
    .filter((col) => col.type !== "done")
    .map((col) => ({
      columnName: col.name, columnType: col.type, columnId: col.id,
      tasks: snap.cards
        .filter((c) => c.columnId === col.id && !c.archivedAt)
        .map((c) => ({ id: c.id, title: c.title, priority: c.priority, description: c.description ?? null })),
    }))
    .filter((col) => col.tasks.length > 0);
  const recentActivity = [
    ...notes.map((n) => ({ type: "note" as const, id: n.id, title: n.title, updatedAt: n.updatedAt })),
    ...snap.cards
      .filter((c) => c.projectId === project.id && !c.archivedAt)
      .map((c) => ({ type: "card" as const, id: c.id, title: c.title, updatedAt: c.updatedAt })),
  ]
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .slice(0, 10);
  return {
    project: {
      id: project.id, name: project.name, description: project.description ?? null,
      status: project.status, priority: project.priority,
      columns: columns.map((c) => ({ id: c.id, name: c.name, type: c.type })),
    },
    noteCount: notes.length,
    pinnedNotes,
    openTasks: openCards,
    recentActivity,
  };
}
