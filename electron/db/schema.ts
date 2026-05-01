/**
 * Cairn — SQLite schema
 *
 * All JSON arrays (tagIds, linkedNoteIds, etc.) are stored as JSON text
 * and deserialized on read. This keeps the schema flat and avoids
 * join tables for the MVP.
 *
 * All timestamps are ISO-8601 strings (TEXT). SQLite has no native
 * datetime type — TEXT sorts correctly for ISO-8601.
 *
 * Migrations are tracked via PRAGMA user_version.
 * Add new migrations to the MIGRATIONS array — never edit existing ones.
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

-- Base indexes (created with the schema for new DBs)
CREATE INDEX IF NOT EXISTS idx_notes_project      ON notes(project_id);
CREATE INDEX IF NOT EXISTS idx_notes_workspace    ON notes(workspace_id);
CREATE INDEX IF NOT EXISTS idx_cards_column       ON task_cards(column_id);
CREATE INDEX IF NOT EXISTS idx_cards_project      ON task_cards(project_id);
CREATE INDEX IF NOT EXISTS idx_columns_project    ON board_columns(project_id);
CREATE INDEX IF NOT EXISTS idx_projects_workspace ON projects(workspace_id);
`;

// ── Versioned migrations ──────────────────────────────────────────────────────
//
// Each migration is a function that receives the open DB connection.
// Migrations run in order, exactly once, tracked by PRAGMA user_version.
//
// Rules:
//   - NEVER edit an existing migration.
//   - NEVER reorder migrations.
//   - Only append new migrations to the array.
//   - Each migration runs inside an implicit transaction via SQLite's
//     BEGIN IMMEDIATE / COMMIT wrapping.

type Migration = (db: Database.Database) => void;

const MIGRATIONS: Migration[] = [
  // v1: Add notes.type column (was ALTER TABLE in the old ad-hoc approach)
  (db) => {
    const cols = db.prepare("PRAGMA table_info(notes)").all() as { name: string }[];
    if (!cols.some((c) => c.name === "type")) {
      db.exec("ALTER TABLE notes ADD COLUMN type TEXT NOT NULL DEFAULT 'note'");
    }
  },

  // v2: Performance indexes for sort/filter hot paths
  (db) => {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_notes_updated_at      ON notes(updated_at);
      CREATE INDEX IF NOT EXISTS idx_notes_archived_at     ON notes(archived_at);
      CREATE INDEX IF NOT EXISTS idx_cards_updated_at      ON task_cards(updated_at);
      CREATE INDEX IF NOT EXISTS idx_cards_archived_at     ON task_cards(archived_at);
      CREATE INDEX IF NOT EXISTS idx_mcp_notifs_read       ON mcp_notifications(read);
      CREATE INDEX IF NOT EXISTS idx_chat_messages_thread  ON chat_messages(thread_id);
    `);
  },

  // v3: Idea Flow — node-based canvas per project
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS idea_flows (
        id          TEXT PRIMARY KEY,
        project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS idea_flow_nodes (
        id         TEXT PRIMARY KEY,
        flow_id    TEXT NOT NULL REFERENCES idea_flows(id) ON DELETE CASCADE,
        type       TEXT NOT NULL,
        x          REAL NOT NULL DEFAULT 0,
        y          REAL NOT NULL DEFAULT 0,
        width      REAL,
        height     REAL,
        data       TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS idea_flow_edges (
        id             TEXT PRIMARY KEY,
        flow_id        TEXT NOT NULL REFERENCES idea_flows(id) ON DELETE CASCADE,
        source_node_id TEXT NOT NULL REFERENCES idea_flow_nodes(id) ON DELETE CASCADE,
        target_node_id TEXT NOT NULL REFERENCES idea_flow_nodes(id) ON DELETE CASCADE,
        label          TEXT,
        created_at     TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_idea_flows_project   ON idea_flows(project_id);
      CREATE INDEX IF NOT EXISTS idx_flow_nodes_flow      ON idea_flow_nodes(flow_id);
      CREATE INDEX IF NOT EXISTS idx_flow_edges_flow      ON idea_flow_edges(flow_id);
      CREATE INDEX IF NOT EXISTS idx_flow_edges_source    ON idea_flow_edges(source_node_id);
      CREATE INDEX IF NOT EXISTS idx_flow_edges_target    ON idea_flow_edges(target_node_id);
    `);
  },

  // v4: Unique constraint on idea_flow_edges to prevent duplicate connections
  (db) => {
    db.exec(`
      DELETE FROM idea_flow_edges
      WHERE id NOT IN (
        SELECT MIN(id) FROM idea_flow_edges
        GROUP BY flow_id, source_node_id, target_node_id
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_flow_edges_unique
        ON idea_flow_edges(flow_id, source_node_id, target_node_id);
    `);
  },

  // v5: Add parent_id to idea_flow_nodes for group sub-flow support
  (db) => {
    const cols = db.prepare("PRAGMA table_info(idea_flow_nodes)").all() as { name: string }[];
    if (!cols.some((c) => c.name === "parent_id")) {
      db.exec("ALTER TABLE idea_flow_nodes ADD COLUMN parent_id TEXT REFERENCES idea_flow_nodes(id) ON DELETE SET NULL");
    }
  },
];

export function applySchema(db: Database.Database): void {
  // PRAGMA foreign_keys must be set per connection — do it first, before exec.
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);
  runMigrations(db);
}

function runMigrations(db: Database.Database): void {
  const currentVersion = (db.pragma("user_version", { simple: true }) as number) ?? 0;

  for (let i = currentVersion; i < MIGRATIONS.length; i++) {
    const migrate = MIGRATIONS[i];
    const nextVersion = i + 1;
    const runMigration = db.transaction(() => {
      migrate(db);
      db.pragma(`user_version = ${nextVersion}`);
    });
    runMigration();
  }
}
