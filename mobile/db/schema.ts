/**
 * Cairn Mobile — SQLite schema (mirrors electron/db/schema.ts)
 *
 * Translated from better-sqlite3 sync API to expo-sqlite async API.
 * The SQL is identical; only the execution model changes.
 */

import type * as SQLite from "expo-sqlite";

// ── Base schema ───────────────────────────────────────────────────────────────
// Identical to the desktop SCHEMA_SQL. The `better-sqlite3` import is stripped.

export const SCHEMA_SQL = `
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
  code_directory TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  archived_at  TEXT
);

CREATE TABLE IF NOT EXISTS notes (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  workspace_id     TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title            TEXT NOT NULL,
  content          TEXT,
  content_text     TEXT NOT NULL DEFAULT '',
  tag_ids          TEXT NOT NULL DEFAULT '[]',
  linked_note_ids  TEXT NOT NULL DEFAULT '[]',
  linked_card_ids  TEXT NOT NULL DEFAULT '[]',
  is_pinned        INTEGER NOT NULL DEFAULT 0,
  type             TEXT NOT NULL DEFAULT 'note',
  folder           TEXT NOT NULL DEFAULT '',
  version          INTEGER NOT NULL DEFAULT 0,
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
  blocked_by_ids   TEXT NOT NULL DEFAULT '[]',
  "order"          INTEGER NOT NULL DEFAULT 0,
  assignee         TEXT,
  version          INTEGER NOT NULL DEFAULT 0,
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
  context_refs TEXT,
  tool_calls   TEXT,
  created_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_notes_project      ON notes(project_id);
CREATE INDEX IF NOT EXISTS idx_notes_workspace    ON notes(workspace_id);
CREATE INDEX IF NOT EXISTS idx_notes_updated_at   ON notes(updated_at);
CREATE INDEX IF NOT EXISTS idx_cards_column       ON task_cards(column_id);
CREATE INDEX IF NOT EXISTS idx_cards_project      ON task_cards(project_id);
CREATE INDEX IF NOT EXISTS idx_cards_updated_at   ON task_cards(updated_at);
CREATE INDEX IF NOT EXISTS idx_columns_project    ON board_columns(project_id);
CREATE INDEX IF NOT EXISTS idx_projects_workspace ON projects(workspace_id);
CREATE INDEX IF NOT EXISTS idx_chat_messages_thread ON chat_messages(thread_id);
`;

// ── Migrations ────────────────────────────────────────────────────────────────
// The mobile schema starts fully up-to-date (all columns included above).
// Migrations here only run against DBs created by the desktop that may be at
// an older user_version. They mirror the desktop migrations exactly.

type Migration = (db: SQLite.SQLiteDatabase) => Promise<void>;

const MIGRATIONS: Migration[] = [
  // v1: notes.type (already in base schema above — safe no-op)
  async (db) => {
    const cols = await db.getAllAsync<{ name: string }>("PRAGMA table_info(notes)");
    if (!cols.some((c) => c.name === "type")) {
      await db.execAsync("ALTER TABLE notes ADD COLUMN type TEXT NOT NULL DEFAULT 'note'");
    }
  },
  // v2: performance indexes (already in base schema)
  async (db) => {
    await db.execAsync(`
      CREATE INDEX IF NOT EXISTS idx_notes_updated_at      ON notes(updated_at);
      CREATE INDEX IF NOT EXISTS idx_notes_archived_at     ON notes(archived_at);
      CREATE INDEX IF NOT EXISTS idx_cards_updated_at      ON task_cards(updated_at);
      CREATE INDEX IF NOT EXISTS idx_cards_archived_at     ON task_cards(archived_at);
      CREATE INDEX IF NOT EXISTS idx_chat_messages_thread  ON chat_messages(thread_id);
    `);
  },
  // v3: idea_flows (not needed for mobile MVP — still applied for schema compat)
  async (db) => {
    await db.execAsync(`
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
      CREATE INDEX IF NOT EXISTS idx_idea_flows_project ON idea_flows(project_id);
      CREATE INDEX IF NOT EXISTS idx_flow_nodes_flow    ON idea_flow_nodes(flow_id);
      CREATE INDEX IF NOT EXISTS idx_flow_edges_flow    ON idea_flow_edges(flow_id);
    `);
  },
  // v4: unique index on idea_flow_edges
  async (db) => {
    await db.execAsync(`
      DELETE FROM idea_flow_edges
      WHERE id NOT IN (
        SELECT MIN(id) FROM idea_flow_edges
        GROUP BY flow_id, source_node_id, target_node_id
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_flow_edges_unique
        ON idea_flow_edges(flow_id, source_node_id, target_node_id);
    `);
  },
  // v5: idea_flow_nodes.parent_id
  async (db) => {
    const cols = await db.getAllAsync<{ name: string }>("PRAGMA table_info(idea_flow_nodes)");
    if (!cols.some((c) => c.name === "parent_id")) {
      await db.execAsync(
        "ALTER TABLE idea_flow_nodes ADD COLUMN parent_id TEXT REFERENCES idea_flow_nodes(id) ON DELETE SET NULL"
      );
    }
  },
  // v6: relationship_cache
  async (db) => {
    await db.execAsync(`
      CREATE TABLE IF NOT EXISTS relationship_cache (
        source_id   TEXT NOT NULL,
        target_id   TEXT NOT NULL,
        type        TEXT NOT NULL,
        weight      REAL NOT NULL DEFAULT 1.0,
        computed_at INTEGER NOT NULL,
        PRIMARY KEY (source_id, target_id, type)
      );
      CREATE INDEX IF NOT EXISTS idx_rel_cache_source ON relationship_cache(source_id);
      CREATE INDEX IF NOT EXISTS idx_rel_cache_target ON relationship_cache(target_id);
    `);
  },
  // v7: task_cards.blocked_by_ids
  async (db) => {
    const cols = await db.getAllAsync<{ name: string }>("PRAGMA table_info(task_cards)");
    if (!cols.some((c) => c.name === "blocked_by_ids")) {
      await db.execAsync("ALTER TABLE task_cards ADD COLUMN blocked_by_ids TEXT NOT NULL DEFAULT '[]'");
    }
  },
  // v8: notes.folder
  async (db) => {
    const cols = await db.getAllAsync<{ name: string }>("PRAGMA table_info(notes)");
    if (!cols.some((c) => c.name === "folder")) {
      await db.execAsync("ALTER TABLE notes ADD COLUMN folder TEXT NOT NULL DEFAULT ''");
    }
  },
  // v9: coding_agents (desktop-only table, create for compat)
  async (db) => {
    await db.execAsync(`
      CREATE TABLE IF NOT EXISTS coding_agents (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        binary_path TEXT NOT NULL,
        args        TEXT NOT NULL DEFAULT '',
        is_default  INTEGER NOT NULL DEFAULT 0,
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  },
  // v10: projects.code_directory (already in base schema)
  async (db) => {
    const cols = await db.getAllAsync<{ name: string }>("PRAGMA table_info(projects)");
    if (!cols.some((c) => c.name === "code_directory")) {
      await db.execAsync("ALTER TABLE projects ADD COLUMN code_directory TEXT");
    }
  },
  // v11: mcp_active_writes (desktop-only)
  async (db) => {
    await db.execAsync(`
      CREATE TABLE IF NOT EXISTS mcp_active_writes (
        note_id    TEXT NOT NULL PRIMARY KEY,
        started_at TEXT NOT NULL
      );
    `);
  },
  // v12: notes.version (already in base schema)
  async (db) => {
    const cols = await db.getAllAsync<{ name: string }>("PRAGMA table_info(notes)");
    if (!cols.some((c) => c.name === "version")) {
      await db.execAsync("ALTER TABLE notes ADD COLUMN version INTEGER NOT NULL DEFAULT 0");
    }
  },
  // v13: task_cards.version (already in base schema)
  async (db) => {
    const cols = await db.getAllAsync<{ name: string }>("PRAGMA table_info(task_cards)");
    if (!cols.some((c) => c.name === "version")) {
      await db.execAsync("ALTER TABLE task_cards ADD COLUMN version INTEGER NOT NULL DEFAULT 0");
    }
  },
  // v14: chat_messages.tool_calls (already in base schema)
  async (db) => {
    const cols = await db.getAllAsync<{ name: string }>("PRAGMA table_info(chat_messages)");
    if (!cols.some((c) => c.name === "tool_calls")) {
      await db.execAsync("ALTER TABLE chat_messages ADD COLUMN tool_calls TEXT");
    }
  },
];

export async function runMigrations(db: SQLite.SQLiteDatabase): Promise<void> {
  const result = await db.getFirstAsync<{ user_version: number }>("PRAGMA user_version");
  const currentVersion = result?.user_version ?? 0;

  for (let i = currentVersion; i < MIGRATIONS.length; i++) {
    await MIGRATIONS[i](db);
    await db.execAsync(`PRAGMA user_version = ${i + 1}`);
  }
}
