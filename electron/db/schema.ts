/**
 * Cairn — SQLite schema
 *
 * All JSON arrays (tagIds, linkedNoteIds, etc.) are stored as JSON text
 * and deserialized on read. This keeps the schema flat and avoids
 * join tables for the MVP.
 *
 * All timestamps are ISO-8601 strings (TEXT). SQLite has no native
 * datetime type — TEXT sorts correctly for ISO-8601.
 */

import type Database from "better-sqlite3";

export const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS workspaces (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT,
  icon        TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  archived_at TEXT
);

CREATE TABLE IF NOT EXISTS projects (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  description  TEXT,
  icon         TEXT,
  status       TEXT NOT NULL DEFAULT 'active',
  priority     TEXT NOT NULL DEFAULT 'medium',
  due_date     TEXT,
  tag_ids      TEXT NOT NULL DEFAULT '[]',
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  archived_at  TEXT
);

CREATE TABLE IF NOT EXISTS notes (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  workspace_id     TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title            TEXT NOT NULL,
  content          TEXT,          -- Raw markdown (type=note) or HTML (type=dashboard)
  content_text     TEXT NOT NULL DEFAULT '',
  tag_ids          TEXT NOT NULL DEFAULT '[]',
  linked_note_ids  TEXT NOT NULL DEFAULT '[]',
  linked_card_ids  TEXT NOT NULL DEFAULT '[]',
  is_pinned        INTEGER NOT NULL DEFAULT 0,
  type             TEXT NOT NULL DEFAULT 'note', -- 'note' | 'dashboard'
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  archived_at      TEXT
);

CREATE TABLE IF NOT EXISTS board_columns (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  type         TEXT NOT NULL DEFAULT 'custom',
  "order"      INTEGER NOT NULL DEFAULT 0,
  card_limit   INTEGER,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS task_cards (
  id               TEXT PRIMARY KEY,
  column_id        TEXT NOT NULL REFERENCES board_columns(id) ON DELETE CASCADE,
  project_id       TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  workspace_id     TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
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
  archived_at      TEXT
);

CREATE TABLE IF NOT EXISTS tags (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  color        TEXT NOT NULL DEFAULT '#6366f1'
);

CREATE TABLE IF NOT EXISTS chat_threads (
  id           TEXT PRIMARY KEY,
  scope        TEXT NOT NULL DEFAULT 'workspace',
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id   TEXT,
  title        TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id           TEXT PRIMARY KEY,
  thread_id    TEXT NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
  role         TEXT NOT NULL,
  content      TEXT NOT NULL,
  context_refs TEXT,   -- JSON array
  created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mcp_notifications (
  id         TEXT PRIMARY KEY,
  tool       TEXT NOT NULL,
  title      TEXT NOT NULL,
  body       TEXT NOT NULL,
  read       INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_notes_project      ON notes(project_id);
CREATE INDEX IF NOT EXISTS idx_notes_workspace    ON notes(workspace_id);
CREATE INDEX IF NOT EXISTS idx_cards_column       ON task_cards(column_id);
CREATE INDEX IF NOT EXISTS idx_cards_project      ON task_cards(project_id);
CREATE INDEX IF NOT EXISTS idx_columns_project    ON board_columns(project_id);
CREATE INDEX IF NOT EXISTS idx_projects_workspace ON projects(workspace_id);
`;

export function applySchema(db: Database.Database): void {
  db.exec(SCHEMA_SQL);
  // ── Migrations ────────────────────────────────────────────────────────────
  // Add columns that were added after the initial schema — safe to run repeatedly.
  const notesCols = db.prepare("PRAGMA table_info(notes)").all() as { name: string }[];
  const noteColNames = notesCols.map((c) => c.name);
  if (!noteColNames.includes("type")) {
    db.exec("ALTER TABLE notes ADD COLUMN type TEXT NOT NULL DEFAULT 'note'");
  }
  if (!noteColNames.includes("mcp_notifications")) {
    // mcp_notifications is a table, not a column — handled by CREATE TABLE IF NOT EXISTS above
  }
}
