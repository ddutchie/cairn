/**
 * Cairn Sync — shared constants for the sync engine.
 *
 * The schema itself (hlc/deleted_at columns, sync_oplog, sync_pending,
 * sync_state, and capture triggers) is created by migrations v25 + v26 in
 * electron/db/schema.ts. This file only holds the table list the engine
 * iterates over, so there is a single source of truth for "what syncs".
 *
 * NOTE: chat_threads / chat_messages are DELIBERATELY not here. Chat is an
 * online-only, device-local surface (see docs/plans/mobile-app-viability.md
 * §5.1 / §7.3) — mobile keeps its own local `chat_local` table with no capture
 * trigger. They were wrongly included originally, which replicated every AI
 * conversation across devices and dominated the oplog (hundreds of chat puts
 * re-applied on every sync). Their historical v26 capture triggers are dropped
 * by a later migration; removing them from this runtime list stops the engine
 * from backfilling/draining/reconciling them.
 */

/** Tables the engine replicates. Order is FK-safe for replay. */
export const SYNCABLE_TABLES = [
  "workspaces",
  "projects",
  "board_columns",
  "tags",
  "notes",
  "task_cards",
  "user_style",
] as const;

export type SyncableTable = (typeof SYNCABLE_TABLES)[number];
