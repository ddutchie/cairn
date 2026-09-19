/**
 * Cairn — chat thread + MCP notification queries.
 *
 * Part of the `electron/db/queries.ts` per-domain split (cleanup Phase 4).
 * Re-exported from `./queries` so existing importers keep working unchanged.
 *
 * Governance: NEVER construct a Database here — these run on the
 * already-constructed handle passed in by the caller. See `./queries.ts`
 * header for the three ABI bootstrap sites.
 */

import type Database from "better-sqlite3";
import { ts } from "./utils";
import { toChatThread, toMcpNotification, type McpNotification, type DbRow } from "../host-shared/db-mappers";

// ── Chat ──────────────────────────────────────

export function getChatThreads(db: Database.Database, workspaceId: string) {
  return db.prepare("SELECT * FROM chat_threads WHERE workspace_id = ? ORDER BY updated_at DESC").all(workspaceId).map((row) => toChatThread(row as DbRow));
}

export function upsertChatThread(db: Database.Database, t: {
  id: string; scope: string; workspaceId: string; projectId?: string; title?: string; useSubagents?: boolean;
}) {
  const now = ts();
  db.prepare(`
    INSERT INTO chat_threads (id, scope, workspace_id, project_id, title, use_subagents, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET title = excluded.title, use_subagents = excluded.use_subagents, updated_at = excluded.updated_at
  `).run(t.id, t.scope, t.workspaceId, t.projectId ?? null, t.title ?? null, t.useSubagents ? 1 : 0, now, now);
  return toChatThread(db.prepare("SELECT * FROM chat_threads WHERE id = ?").get(t.id) as DbRow);
}

export function deleteChatThread(db: Database.Database, threadId: string) {
  db.prepare("DELETE FROM chat_threads WHERE id = ?").run(threadId);
}

// ── MCP Notifications ─────────────────────────

export function getUnreadMcpNotifications(db: Database.Database): McpNotification[] {
  return db.prepare("SELECT * FROM mcp_notifications WHERE read = 0 ORDER BY created_at ASC").all().map((row) => toMcpNotification(row as DbRow));
}

/** Recent notifications (read + unread), newest first. */
export function listMcpNotifications(db: Database.Database, limit = 100): McpNotification[] {
  return db
    .prepare("SELECT * FROM mcp_notifications ORDER BY created_at DESC, rowid DESC LIMIT ?")
    .all(limit)
    .map((row) => toMcpNotification(row as DbRow));
}

export function countUnreadMcpNotifications(db: Database.Database): number {
  const r = db.prepare("SELECT COUNT(*) AS n FROM mcp_notifications WHERE read = 0").get() as { n: number };
  return r.n;
}

export function markMcpNotificationRead(db: Database.Database, id: string): void {
  db.prepare("UPDATE mcp_notifications SET read = 1 WHERE id = ?").run(id);
}

export function markMcpNotificationsRead(db: Database.Database): void {
  db.prepare("UPDATE mcp_notifications SET read = 1 WHERE read = 0").run();
}

/** Remove every notification (manual "Clear all"). Returns rows deleted. */
export function clearMcpNotifications(db: Database.Database): number {
  const info = db.prepare("DELETE FROM mcp_notifications").run();
  return info.changes;
}

/**
 * Retention/pruning for mcp_notifications: delete notifications older than
 * `maxAgeDays`, then cap the table to the newest `maxRows`. Returns the number
 * of rows deleted. Notifications are transient activity (toasts/inbox), so they
 * don't need indefinite retention.
 */
export function pruneMcpNotifications(db: Database.Database, opts: { maxAgeDays?: number; maxRows?: number } = {}): number {
  const maxAgeDays = opts.maxAgeDays ?? 30;
  const maxRows = opts.maxRows ?? 1000;
  const cutoffIso = new Date(Date.now() - maxAgeDays * 86_400_000).toISOString();
  const prune = db.transaction((cutoff: string, cap: number) => {
    const ageInfo = db.prepare("DELETE FROM mcp_notifications WHERE created_at < ?").run(cutoff);
    const capInfo = db.prepare(`
      DELETE FROM mcp_notifications
      WHERE id NOT IN (
        SELECT id FROM mcp_notifications ORDER BY created_at DESC, rowid DESC LIMIT ?
      )
    `).run(cap);
    return ageInfo.changes + capInfo.changes;
  });
  return prune(cutoffIso, maxRows);
}

/**
 * Returns the set of note IDs currently being written by the MCP server process.
 * Used by mcp-poller to diff against the previous poll and fire aiWriteStarted/Ended events.
 * Returns an empty set if the table doesn't exist yet (e.g. pre-v11 DB).
 */
export function getActiveMcpWrites(db: Database.Database): Set<string> {
  try {
    const rows = db.prepare("SELECT note_id FROM mcp_active_writes").all() as { note_id: string }[];
    return new Set(rows.map((r) => r.note_id));
  } catch {
    return new Set();
  }
}

export function insertMcpNotification(db: Database.Database, n: { id: string; tool: string; title: string; body: string; targetType?: "note" | "task"; targetId?: string }): void {
  db.prepare("INSERT INTO mcp_notifications (id, tool, title, body, read, created_at, target_type, target_id) VALUES (?, ?, ?, ?, 0, ?, ?, ?)")
    .run(n.id, n.tool, n.title, n.body, ts(), n.targetType ?? null, n.targetId ?? null);
}
