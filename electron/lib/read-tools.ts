/**
 * Cairn — Shared read-tool implementations
 *
 * These tools are called from three places:
 *   1. chat-executor.ts  (AI chat tool loop)
 *   2. handlers.ts       (db:mcpQuery IPC — used by dashboard iframes)
 *   3. mcp-server.ts     (standalone MCP binary — has its own snapshot model,
 *                         does NOT import from here due to ABI isolation)
 *
 * All functions operate on a pre-fetched snapshot so no extra DB round-trips
 * occur when multiple tools are called in a single AI turn.
 *
 * Return shapes are defined by ProjectSummaryResult in src/types/index.ts.
 * Keep them in sync with mcp-server.ts manually.
 */

import type Database from "better-sqlite3";
import * as q from "../db/queries";

// ── Snapshot type (mirrors getFullSnapshot return) ──────────────────────────

export interface CairnSnapshot {
  workspaces: Array<{ id: string; name: string; [k: string]: unknown }>;
  projects: Array<{
    id: string; workspaceId: string; name: string; description?: string;
    status: string; priority: string; dueDate?: string; archivedAt?: string;
    tagIds: string[]; createdAt: string; updatedAt: string;
  }>;
  notes: Array<{
    id: string; projectId: string; workspaceId: string; title: string;
    content: string; contentText: string; tagIds: string[];
    linkedNoteIds: string[]; linkedCardIds: string[];
    isPinned: boolean; type: string; folder?: string;
    createdAt: string; updatedAt: string; archivedAt?: string;
  }>;
  columns: Array<{
    id: string; projectId: string; workspaceId: string; name: string;
    type: string; order: number; createdAt: string; updatedAt: string;
  }>;
  cards: Array<{
    id: string; columnId: string; projectId: string; workspaceId: string;
    title: string; description?: string; priority: string; dueDate?: string;
    linkedNoteIds: string[]; blockedByIds: string[]; tagIds: string[]; order: number;
    assignee?: string; createdAt: string; updatedAt: string; archivedAt?: string;
  }>;
  tags: Array<{ id: string; workspaceId: string; name: string; color: string }>;
}

// ── Tool args (permissive — callers validate before reaching here) ───────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Args = Record<string, any>;

// ── Implementations ──────────────────────────────────────────────────────────

export function executeGetProjectSummary(snap: CairnSnapshot, args: Args): unknown {
  const project = snap.projects.find((p) => p.id === args.projectId);
  if (!project) return { error: "Project not found" };
  const columns = snap.columns
    .filter((c) => c.projectId === args.projectId)
    .sort((a, b) => a.order - b.order);
  const notes = snap.notes.filter((n) => n.projectId === args.projectId && !n.archivedAt);
  const cardsByColumn = columns.map((col) => {
    const cards = snap.cards.filter((c) => c.columnId === col.id && !c.archivedAt);
    return {
      columnName: col.name,
      columnType: col.type,
      count: cards.length,
      cards: cards.map((c) => ({ id: c.id, title: c.title, priority: c.priority, dueDate: c.dueDate ?? null })),
    };
  });
  const totalCards = cardsByColumn.reduce((s, c) => s + c.count, 0);
  const recentActivity = [
    ...notes.map((n) => ({ type: "note" as const, id: n.id, title: n.title, updatedAt: n.updatedAt })),
    ...snap.cards
      .filter((c) => c.projectId === args.projectId && !c.archivedAt)
      .map((c) => ({ type: "card" as const, id: c.id, title: c.title, updatedAt: c.updatedAt })),
  ]
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .slice(0, 10);
  return {
    project: {
      id: project.id, name: project.name, description: project.description,
      status: project.status, priority: project.priority, dueDate: project.dueDate ?? null,
    },
    noteCount: notes.length,
    totalCards,
    cardsByColumn,
    pinnedNotes: notes.filter((n) => n.isPinned).map((n) => ({ id: n.id, title: n.title })),
    recentActivity,
  };
}

export function executeListTasks(snap: CairnSnapshot, args: Args): unknown {
  const cols = snap.columns
    .filter((c) => !args.projectId || c.projectId === args.projectId)
    .sort((a, b) => a.order - b.order);
  // chat-executor supports an optional columnType filter; db:mcpQuery does not pass one
  return cols
    .filter((c) => !args.columnType || c.type === args.columnType)
    .map((col) => ({
      columnName: col.name,
      columnType: col.type,
      columnId: col.id,
      tasks: snap.cards
        .filter((c) => c.columnId === col.id && !c.archivedAt)
        .map((c) => ({ id: c.id, title: c.title, priority: c.priority, description: c.description })),
    }));
}

export function executeListNotes(snap: CairnSnapshot, args: Args): unknown {
  return snap.notes
    .filter((n) => !n.archivedAt && (!args.projectId || n.projectId === args.projectId))
    .map((n) => ({ id: n.id, title: n.title, projectId: n.projectId, folder: n.folder ?? "", isPinned: n.isPinned, updatedAt: n.updatedAt }));
}

export function executeListRecentActivity(snap: CairnSnapshot, args: Args): unknown {
  const limit = (args.limit as number) ?? 20;
  const recentNotes = snap.notes
    .filter((n) => !n.archivedAt
      && (!args.workspaceId || n.workspaceId === args.workspaceId)
      && (!args.projectId || n.projectId === args.projectId))
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .slice(0, limit)
    .map((n) => ({ id: n.id, title: n.title, projectId: n.projectId, updatedAt: n.updatedAt }));
  const recentTasks = snap.cards
    .filter((c) => !c.archivedAt
      && (!args.workspaceId || c.workspaceId === args.workspaceId)
      && (!args.projectId || c.projectId === args.projectId))
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .slice(0, limit)
    .map((c) => ({ id: c.id, title: c.title, projectId: c.projectId, updatedAt: c.updatedAt }));
  return { recentNotes, recentTasks };
}

export function executeSearchNotes(db: Database.Database, args: Args): unknown {
  return q.searchNotes(db, {
    query: String(args.query),
    projectId: args.projectId as string | undefined,
    limit: args.limit as number | undefined,
  }).map((n) => ({ id: n.id, title: n.title, snippet: n.contentText.slice(0, 200), projectId: n.projectId, updatedAt: n.updatedAt }));
}

export function executeSearchTasks(db: Database.Database, snap: CairnSnapshot, args: Args): unknown {
  return q.searchTasks(db, {
    query: String(args.query),
    projectId: args.projectId as string | undefined,
    limit: args.limit as number | undefined,
  }).map((c) => {
    const col = snap.columns.find((col) => col.id === c.columnId);
    return {
      id: c.id, title: c.title, description: c.description ?? null,
      columnId: c.columnId, columnName: col?.name ?? "Unknown", columnType: col?.type ?? "custom",
      priority: c.priority, dueDate: c.dueDate ?? null, projectId: c.projectId,
    };
  });
}

export function executeGetProjectContextPack(snap: CairnSnapshot, args: Args): unknown {
  const project = snap.projects.find((p) => p.id === args.projectId);
  if (!project) return { error: "Project not found" };
  const columns = snap.columns
    .filter((c) => c.projectId === project.id)
    .sort((a, b) => a.order - b.order);
  const notes = snap.notes.filter((n) => n.projectId === project.id && !n.archivedAt);
  // Pinned notes with full content — useful for context-setting docs
  const pinnedNotes = notes
    .filter((n) => n.isPinned)
    .map((n) => ({ id: n.id, title: n.title, content: n.content }));
  // Open (non-done) tasks only — done tasks are noise for an agent planning work
  const openCards = columns
    .filter((col) => col.type !== "done")
    .map((col) => ({
      columnName: col.name,
      columnType: col.type,
      columnId: col.id,
      tasks: snap.cards
        .filter((c) => c.columnId === col.id && !c.archivedAt)
        .map((c) => ({ id: c.id, title: c.title, priority: c.priority, description: c.description ?? null })),
    }))
    .filter((col) => col.tasks.length > 0);
  // Recent activity — last 10 across notes + tasks
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

/**
 * Dispatch a read-only tool by name. Used by db:mcpQuery in handlers.ts and
 * can be used by chat-executor.ts for the shared read-only subset.
 *
 * Returns `null` if the tool name is not handled here (caller should fall through
 * to its own switch for write tools / chat-only tools).
 */
export function executeReadTool(
  db: Database.Database,
  snap: CairnSnapshot,
  tool: string,
  args: Args,
): { handled: true; result: unknown } | { handled: false } {
  switch (tool) {
    case "get_project_summary":
      return { handled: true, result: executeGetProjectSummary(snap, args) };
    case "get_project_context_pack":
      return { handled: true, result: executeGetProjectContextPack(snap, args) };
    case "list_tasks":
      return { handled: true, result: executeListTasks(snap, args) };
    case "list_notes":
      return { handled: true, result: executeListNotes(snap, args) };
    case "list_recent_activity":
      return { handled: true, result: executeListRecentActivity(snap, args) };
    case "search_notes":
      return { handled: true, result: executeSearchNotes(db, args) };
    case "search_tasks":
      return { handled: true, result: executeSearchTasks(db, snap, args) };
    default:
      return { handled: false };
  }
}
