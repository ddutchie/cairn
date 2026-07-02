/**
 * Cairn Sync — shared constants for the sync engine.
 *
 * The schema itself (hlc/deleted_at columns, sync_oplog, sync_pending,
 * sync_state, and capture triggers) is created by migrations v25 + v26 in
 * electron/db/schema.ts. This file only holds the table list the engine
 * iterates over, so there is a single source of truth for "what syncs".
 */

/** Tables the engine replicates. Order is FK-safe for replay. */
export const SYNCABLE_TABLES = [
  "workspaces",
  "projects",
  "board_columns",
  "tags",
  "notes",
  "task_cards",
  "chat_threads",
  "chat_messages",
] as const;

export type SyncableTable = (typeof SYNCABLE_TABLES)[number];
