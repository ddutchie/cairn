/**
 * Mobile SQLite schema.
 *
 * The mobile app holds only the SYNCABLE subset of the desktop schema — it
 * receives all content via the sync oplog, so it does not need desktop-only
 * tables (embeddings, mcp_*, idea_flow_*, pi_agent_*, etc.).
 *
 * Every table already includes the sync columns (hlc, deleted_at) that the
 * desktop added in migrations v25/v26 — here they are part of the base schema
 * since the mobile DB is created fresh. Column names/types MUST match the
 * desktop exactly so oplog row snapshots apply cleanly.
 *
 * The sync engine tables (sync_oplog, sync_pending, sync_state) and capture
 * triggers mirror desktop migrations v25/v26.
 */

import { SYNCABLE_TABLES } from "@cairn/shared/sync/schema";

export const MOBILE_SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = OFF; -- sync applies rows in oplog order, not FK order

CREATE TABLE IF NOT EXISTS workspaces (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT,
  icon        TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  archived_at TEXT,
  hlc         TEXT,
  deleted_at  TEXT
);

CREATE TABLE IF NOT EXISTS projects (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name         TEXT NOT NULL,
  description  TEXT,
  icon         TEXT,
  status       TEXT NOT NULL DEFAULT 'active',
  priority     TEXT NOT NULL DEFAULT 'medium',
  due_date     TEXT,
  tag_ids      TEXT NOT NULL DEFAULT '[]',
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  archived_at  TEXT,
  project_settings TEXT NOT NULL DEFAULT '{}',
  code_directory   TEXT,
  hlc          TEXT,
  deleted_at   TEXT
);

CREATE TABLE IF NOT EXISTS board_columns (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  name         TEXT NOT NULL,
  type         TEXT NOT NULL DEFAULT 'custom',
  "order"      INTEGER NOT NULL DEFAULT 0,
  card_limit   INTEGER,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  hlc          TEXT,
  deleted_at   TEXT
);

CREATE TABLE IF NOT EXISTS tags (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name         TEXT NOT NULL,
  color        TEXT NOT NULL DEFAULT '#6366f1',
  created_at   TEXT,
  updated_at   TEXT,
  hlc          TEXT,
  deleted_at   TEXT
);

CREATE TABLE IF NOT EXISTS notes (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL,
  workspace_id     TEXT NOT NULL,
  title            TEXT NOT NULL,
  content          TEXT,
  content_text     TEXT NOT NULL DEFAULT '',
  tag_ids          TEXT NOT NULL DEFAULT '[]',
  linked_note_ids  TEXT NOT NULL DEFAULT '[]',
  linked_card_ids  TEXT NOT NULL DEFAULT '[]',
  is_pinned        INTEGER NOT NULL DEFAULT 0,
  type             TEXT NOT NULL DEFAULT 'note',
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  archived_at      TEXT,
  folder           TEXT NOT NULL DEFAULT '',
  version          INTEGER NOT NULL DEFAULT 0,
  hlc              TEXT,
  deleted_at       TEXT
);

CREATE TABLE IF NOT EXISTS task_cards (
  id               TEXT PRIMARY KEY,
  column_id        TEXT NOT NULL,
  project_id       TEXT NOT NULL,
  workspace_id     TEXT NOT NULL,
  title            TEXT NOT NULL,
  description      TEXT,
  tag_ids          TEXT NOT NULL DEFAULT '[]',
  priority         TEXT NOT NULL DEFAULT 'medium',
  due_date         TEXT,
  linked_note_ids  TEXT NOT NULL DEFAULT '[]',
  "order"          INTEGER NOT NULL DEFAULT 0,
  assignee         TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  archived_at      TEXT,
  blocked_by_ids   TEXT NOT NULL DEFAULT '[]',
  version          INTEGER NOT NULL DEFAULT 0,
  hlc              TEXT,
  deleted_at       TEXT
);

CREATE TABLE IF NOT EXISTS chat_threads (
  id           TEXT PRIMARY KEY,
  scope        TEXT NOT NULL DEFAULT 'workspace',
  workspace_id TEXT NOT NULL,
  project_id   TEXT,
  title        TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  hlc          TEXT,
  deleted_at   TEXT
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id           TEXT PRIMARY KEY,
  thread_id    TEXT NOT NULL,
  role         TEXT NOT NULL,
  content      TEXT NOT NULL,
  context_refs TEXT,
  created_at   TEXT NOT NULL,
  tool_calls   TEXT,
  reasoning    TEXT,
  hlc          TEXT,
  deleted_at   TEXT
);

CREATE INDEX IF NOT EXISTS idx_notes_project   ON notes(project_id);
CREATE INDEX IF NOT EXISTS idx_notes_workspace ON notes(workspace_id);
CREATE INDEX IF NOT EXISTS idx_cards_column    ON task_cards(column_id);
CREATE INDEX IF NOT EXISTS idx_cards_project   ON task_cards(project_id);
CREATE INDEX IF NOT EXISTS idx_columns_project ON board_columns(project_id);

-- Local-only chat log. Deliberately SEPARATE from the synced chat_threads/
-- chat_messages tables and has NO capture trigger, so mobile chat history stays
-- entirely on-device and never publishes to (or receives from) the sync folder.
-- role: 'user' | 'assistant'. images/tools are JSON blobs for UI restore.
CREATE TABLE IF NOT EXISTS chat_local (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  role       TEXT NOT NULL,
  content    TEXT NOT NULL DEFAULT '',
  images     TEXT,
  tools      TEXT,
  created_at TEXT NOT NULL
);

-- Local-only, on-device app settings (key/value). NO capture trigger, so it
-- never publishes to or pulls from the sync folder. Holds non-secret AI config
-- (OpenAI-compatible base URL, model). Secrets like the API key live in
-- expo-secure-store (keychain), NOT here.
CREATE TABLE IF NOT EXISTS app_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Sync engine tables (mirror desktop migrations v25/v26).
CREATE TABLE IF NOT EXISTS sync_oplog (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  hlc        TEXT NOT NULL,
  origin     TEXT NOT NULL,
  entity     TEXT NOT NULL,
  entity_id  TEXT NOT NULL,
  op         TEXT NOT NULL,
  payload    TEXT,
  applied_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_oplog_hlc    ON sync_oplog(hlc);
CREATE INDEX IF NOT EXISTS idx_oplog_entity ON sync_oplog(entity, entity_id);

CREATE TABLE IF NOT EXISTS sync_pending (
  seq       INTEGER PRIMARY KEY AUTOINCREMENT,
  entity    TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  op        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

/**
 * Capture triggers — identical semantics to desktop v26. Read-only P3 does not
 * yet stage local writes, but installing them now keeps the mobile schema in
 * lock-step with desktop so P4 (mobile writes) needs no migration.
 */
export const MOBILE_TRIGGERS_SQL = (() => {
  const suppressGuard = `(SELECT COALESCE((SELECT value FROM sync_state WHERE key='suppress'),'0')) = '0'`;
  // Single source of truth for "what syncs" lives in @cairn/shared.
  const tables = SYNCABLE_TABLES;
  return tables
    .map(
      (t) => `
    CREATE TRIGGER IF NOT EXISTS trg_sync_${t}_ins AFTER INSERT ON ${t}
    WHEN ${suppressGuard}
    BEGIN INSERT INTO sync_pending (entity, entity_id, op) VALUES ('${t}', NEW.id, 'put'); END;

    CREATE TRIGGER IF NOT EXISTS trg_sync_${t}_upd AFTER UPDATE ON ${t}
    WHEN ${suppressGuard}
    BEGIN INSERT INTO sync_pending (entity, entity_id, op)
      VALUES ('${t}', NEW.id, CASE WHEN NEW.deleted_at IS NOT NULL THEN 'delete' ELSE 'put' END); END;

    CREATE TRIGGER IF NOT EXISTS trg_sync_${t}_del AFTER DELETE ON ${t}
    WHEN ${suppressGuard}
    BEGIN INSERT INTO sync_pending (entity, entity_id, op) VALUES ('${t}', OLD.id, 'delete'); END;
  `,
    )
    .join("\n");
})();
