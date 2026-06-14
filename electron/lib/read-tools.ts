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
import {
  CairnSnapshot,
  executeGetProjectSummary,
  executeListTasks,
  executeListNotes,
  executeListRecentActivity,
  executeGetProjectContextPack
} from "../shared/read-tools-pure";

export { CairnSnapshot };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Args = Record<string, any>;

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
    const limit = 400;
    const desc = c.description ?? "";
    const truncated = desc.length > limit
      ? desc.slice(0, limit) + "\n... (description truncated, use get_task to read full description)"
      : (c.description ?? null);
    return {
      id: c.id, title: c.title, description: truncated,
      columnId: c.columnId, columnName: col?.name ?? "Unknown", columnType: col?.type ?? "custom",
      priority: c.priority, dueDate: c.dueDate ?? null, projectId: c.projectId,
    };
  });
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
