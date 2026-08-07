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

/**
 * The tables replicated by Device Sync, as of migrations v25/v26. Hoisted to a
 * single constant so the v25 (column) and v26 (trigger) migrations can't drift.
 * NOTE: this is intentionally a frozen snapshot for those historical migrations
 * — adding a new syncable table requires its own new migration, not editing v25/v26.
 */
const SYNCABLE_V25_V26 = [
  "workspaces", "projects", "board_columns", "tags",
  "notes", "task_cards", "chat_threads", "chat_messages",
] as const;

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

  // v6: Knowledge graph — relationship cache table
  (db) => {
    db.exec(`
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

  // v7: Card dependency system — blocked_by_ids stores JSON array of blocking card IDs
  (db) => {
    const cols = db.prepare("PRAGMA table_info(task_cards)").all() as { name: string }[];
    if (!cols.some((c) => c.name === "blocked_by_ids")) {
      db.exec("ALTER TABLE task_cards ADD COLUMN blocked_by_ids TEXT NOT NULL DEFAULT '[]'");
    }
  },

  // v8: Note subfolders — folder stores a slash-separated path within the project notes dir
  (db) => {
    const cols = db.prepare("PRAGMA table_info(notes)").all() as { name: string }[];
    if (!cols.some((c) => c.name === "folder")) {
      db.exec("ALTER TABLE notes ADD COLUMN folder TEXT NOT NULL DEFAULT ''");
    }
  },

  // v9: Coding agents — global registry of AI coding agent CLI configurations
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS coding_agents (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        binary_path TEXT NOT NULL,
        args        TEXT NOT NULL DEFAULT '',
        is_default  INTEGER NOT NULL DEFAULT 0,
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_coding_agents_default ON coding_agents(is_default);
    `);
  },

  // v10: Project code directory — filesystem path scoping agent sessions per project
  (db) => {
    const cols = db.prepare("PRAGMA table_info(projects)").all() as { name: string }[];
    if (!cols.some((c) => c.name === "code_directory")) {
      db.exec("ALTER TABLE projects ADD COLUMN code_directory TEXT");
    }
  },

  // v11: MCP active writes — tracks note IDs being written by the MCP server process
  // so the Electron renderer can show a read-only indicator on the active note.
  // The MCP process creates this table on startup via an inline CREATE TABLE IF NOT EXISTS
  // (it cannot call applySchema due to the Node ABI boundary).
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS mcp_active_writes (
        note_id    TEXT NOT NULL PRIMARY KEY,
        started_at TEXT NOT NULL
      );
    `);
  },

  // v12: Optimistic concurrency — version counter on notes.
  // Incremented on every write so MCP tools can detect mid-air collisions via
  // an optional expectedVersion argument.
  (db) => {
    const cols = db.prepare("PRAGMA table_info(notes)").all() as { name: string }[];
    if (!cols.some((c) => c.name === "version")) {
      db.exec("ALTER TABLE notes ADD COLUMN version INTEGER NOT NULL DEFAULT 0");
    }
  },

  // v13: Optimistic concurrency — version counter on task_cards.
  // Same pattern as v12 notes — lets MCP detect stale update attempts.
  (db) => {
    const cols = db.prepare("PRAGMA table_info(task_cards)").all() as { name: string }[];
    if (!cols.some((c) => c.name === "version")) {
      db.exec("ALTER TABLE task_cards ADD COLUMN version INTEGER NOT NULL DEFAULT 0");
    }
  },

  // v14: Persist tool calls on chat messages so they survive the streaming
  // phase and remain visible in the message history after the response is done.
  (db) => {
    const cols = db.prepare("PRAGMA table_info(chat_messages)").all() as { name: string }[];
    if (!cols.some((c) => c.name === "tool_calls")) {
      db.exec("ALTER TABLE chat_messages ADD COLUMN tool_calls TEXT");
    }
  },

  // v15: Pi Agent persistent tab & session history — stores per-project agent
  // sessions, their display messages, and the raw LLM context window so sessions
  // can be resumed across app restarts.
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS pi_agent_sessions (
        id           TEXT PRIMARY KEY,
        project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        task_title   TEXT NOT NULL DEFAULT 'Ad-hoc session',
        task_id      TEXT,
        cwd          TEXT NOT NULL,
        mode         TEXT NOT NULL DEFAULT 'execute',
        plan_note_id TEXT,
        status       TEXT NOT NULL DEFAULT 'running',
        spawned_at   TEXT NOT NULL,
        updated_at   TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS pi_agent_messages (
        id           TEXT PRIMARY KEY,
        session_id   TEXT NOT NULL REFERENCES pi_agent_sessions(id) ON DELETE CASCADE,
        role         TEXT NOT NULL,
        content      TEXT NOT NULL DEFAULT '',
        tool_calls   TEXT,
        subagents    TEXT,
        timestamp    TEXT NOT NULL,
        "order"      INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS pi_agent_llm_history (
        session_id TEXT NOT NULL REFERENCES pi_agent_sessions(id) ON DELETE CASCADE,
        "order"    INTEGER NOT NULL,
        role       TEXT NOT NULL,
        content    TEXT NOT NULL,
        PRIMARY KEY (session_id, "order")
      );

      CREATE INDEX IF NOT EXISTS idx_pi_sessions_project ON pi_agent_sessions(project_id);
      CREATE INDEX IF NOT EXISTS idx_pi_messages_session ON pi_agent_messages(session_id);
    `);
  },

  // v16: Local semantic codebase indexing tables
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS codebase_files (
        id          TEXT PRIMARY KEY,
        root_path   TEXT NOT NULL,
        file_path   TEXT NOT NULL UNIQUE,
        hash        TEXT NOT NULL,
        indexed_at  TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS codebase_symbols (
        id          TEXT PRIMARY KEY,
        file_id     TEXT NOT NULL REFERENCES codebase_files(id) ON DELETE CASCADE,
        name        TEXT NOT NULL,
        kind        TEXT NOT NULL,
        line        INTEGER NOT NULL,
        signature   TEXT NOT NULL,
        docstring   TEXT
      );

      CREATE TABLE IF NOT EXISTS codebase_relations (
        source_id   TEXT NOT NULL REFERENCES codebase_symbols(id) ON DELETE CASCADE,
        target_name TEXT NOT NULL,
        type        TEXT NOT NULL,
        PRIMARY KEY (source_id, target_name, type)
      );

      CREATE INDEX IF NOT EXISTS idx_codebase_files_root_path ON codebase_files(root_path);
      CREATE INDEX IF NOT EXISTS idx_codebase_symbols_file_id ON codebase_symbols(file_id);
      CREATE INDEX IF NOT EXISTS idx_codebase_symbols_name ON codebase_symbols(name);
      CREATE INDEX IF NOT EXISTS idx_codebase_relations_source_id ON codebase_relations(source_id);
      CREATE INDEX IF NOT EXISTS idx_codebase_relations_target_name ON codebase_relations(target_name);
    `);
  },

  // v17: Embedding storage for semantic graph + adjacent-notes (JSON-TEXT vector
  // bridge; the column shape is deliberately sqlite-vec-compatible so the eventual
  // swap to a vec0 virtual table only needs a column rename, not a rewrite).
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS note_embeddings (
        note_id        TEXT PRIMARY KEY REFERENCES notes(id) ON DELETE CASCADE,
        workspace_id   TEXT NOT NULL,
        model          TEXT NOT NULL,
        task           TEXT NOT NULL,
        content_hash   TEXT NOT NULL,
        vector         TEXT NOT NULL,
        embedded_at    TEXT NOT NULL,
        dim_x          REAL,
        dim_y          REAL,
        proj_stale     INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX IF NOT EXISTS idx_emb_workspace ON note_embeddings(workspace_id);
      CREATE INDEX IF NOT EXISTS idx_emb_proj_stale ON note_embeddings(proj_stale);
      CREATE INDEX IF NOT EXISTS idx_emb_task ON note_embeddings(task);
    `);
  },

  // v18: Section-based embeddings — one note can have multiple embedding rows,
  // one per markdown section (## / # header boundary). Adds section_idx + section_title,
  // changes PK from (note_id) to (note_id, section_idx). Old data is migrated as
  // section_idx=0, section_title=''. This enables much finer-grained semantic matching
  // because notes with multiple topics no longer have their embedding diluted by averaging.
  // Also adds source_section_title / target_section_title to relationship_cache so the
  // semantic edges can carry which sections matched.
  (db) => {
    db.exec(`
      ALTER TABLE note_embeddings RENAME TO note_embeddings_v17;
      CREATE TABLE note_embeddings (
        note_id        TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
        section_idx    INTEGER NOT NULL DEFAULT 0,
        workspace_id   TEXT NOT NULL,
        model          TEXT NOT NULL,
        task           TEXT NOT NULL,
        section_title  TEXT NOT NULL DEFAULT '',
        content_hash   TEXT NOT NULL,
        vector         TEXT NOT NULL,
        embedded_at    TEXT NOT NULL,
        dim_x          REAL,
        dim_y          REAL,
        proj_stale     INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (note_id, section_idx)
      );
      INSERT INTO note_embeddings (note_id, section_idx, workspace_id, model, task, section_title, content_hash, vector, embedded_at, dim_x, dim_y, proj_stale)
      SELECT note_id, 0, workspace_id, model, task, '', content_hash, vector, embedded_at, dim_x, dim_y, proj_stale
      FROM note_embeddings_v17;
      DROP TABLE note_embeddings_v17;
      CREATE INDEX IF NOT EXISTS idx_emb_workspace ON note_embeddings(workspace_id);
      CREATE INDEX IF NOT EXISTS idx_emb_proj_stale ON note_embeddings(proj_stale);
      CREATE INDEX IF NOT EXISTS idx_emb_task ON note_embeddings(task);

      ALTER TABLE relationship_cache ADD COLUMN source_section_title TEXT;
      ALTER TABLE relationship_cache ADD COLUMN target_section_title TEXT;
    `);
  },

  // v19: Failsafe — if v18 ran before the ALTER TABLE statements were added
  // (the v18 migration was edited after initial deployment), the
  // source_section_title / target_section_title columns won't exist on
  // relationship_cache. This migration adds them idempotently.
  (db) => {
    const cols = db.prepare("PRAGMA table_info(relationship_cache)").all() as Array<{ name: string }>;
    const has = (name: string) => cols.some((c) => c.name === name);
    if (!has("source_section_title")) {
      db.exec("ALTER TABLE relationship_cache ADD COLUMN source_section_title TEXT");
    }
    if (!has("target_section_title")) {
      db.exec("ALTER TABLE relationship_cache ADD COLUMN target_section_title TEXT");
    }
  },

  // v20: Persist reasoning / thinking text on chat messages so the
  // collapsible "Thinking" panel survives app restarts. Mirrors v14's
  // approach for tool_calls. Also covers pi_agent_messages so terminal
  // agent sessions retain their thinking across restarts too.
  (db) => {
    const chatCols = db.prepare("PRAGMA table_info(chat_messages)").all() as { name: string }[];
    if (!chatCols.some((c) => c.name === "reasoning")) {
      db.exec("ALTER TABLE chat_messages ADD COLUMN reasoning TEXT");
    }
    const piCols = db.prepare("PRAGMA table_info(pi_agent_messages)").all() as { name: string }[];
    if (!piCols.some((c) => c.name === "reasoning")) {
      db.exec("ALTER TABLE pi_agent_messages ADD COLUMN reasoning TEXT");
    }
  },

  // v21: Per-project agent settings — PR template, git defaults, etc.
  (db) => {
    const cols = db.prepare("PRAGMA table_info(projects)").all() as { name: string }[];
    if (!cols.some((c) => c.name === "project_settings")) {
      db.exec("ALTER TABLE projects ADD COLUMN project_settings TEXT NOT NULL DEFAULT '{}'");
    }
  },

  // v22: External tools — remote MCP servers + custom HTTP services the AI can
  // use, plus per-project attachment flags. Workspace-scoped definitions;
  // tool_attachments rows enable/attach a tool per project (projectId
  // '__global__' = always-on). Secret header values are stored as
  // "secret://<toolId>/<header>" refs; real values live in the OS keychain.
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS mcp_servers (
        id           TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        name         TEXT NOT NULL,
        description  TEXT,
        transport    TEXT NOT NULL DEFAULT 'http',
        base_url     TEXT NOT NULL,
        headers      TEXT NOT NULL DEFAULT '{}',
        enabled      INTEGER NOT NULL DEFAULT 1,
        source       TEXT NOT NULL DEFAULT 'manual',
        community_id TEXT,
        version      TEXT,
        created_at   TEXT NOT NULL,
        updated_at   TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS custom_services (
        id              TEXT PRIMARY KEY,
        workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        name            TEXT NOT NULL,
        description     TEXT,
        api_url         TEXT NOT NULL,
        method          TEXT NOT NULL DEFAULT 'GET',
        headers         TEXT NOT NULL DEFAULT '{}',
        tool_definition TEXT NOT NULL,
        base_url        TEXT,
        operations      TEXT,
        response_keys   TEXT NOT NULL DEFAULT '[]',
        api_key_url     TEXT,
        enabled         INTEGER NOT NULL DEFAULT 1,
        source          TEXT NOT NULL DEFAULT 'manual',
        community_id    TEXT,
        version         TEXT,
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tool_attachments (
        project_id TEXT NOT NULL,
        tool_type  TEXT NOT NULL,
        tool_id    TEXT NOT NULL,
        enabled    INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (project_id, tool_type, tool_id)
      );

      CREATE INDEX IF NOT EXISTS idx_mcp_servers_workspace     ON mcp_servers(workspace_id);
      CREATE INDEX IF NOT EXISTS idx_custom_services_workspace ON custom_services(workspace_id);
      CREATE INDEX IF NOT EXISTS idx_tool_attachments_project  ON tool_attachments(project_id);
      CREATE INDEX IF NOT EXISTS idx_tool_attachments_tool     ON tool_attachments(tool_id);
    `);
  },

  // v23: OAuth for remote MCP servers. auth_mode 'none' keeps the existing
  // static-header behaviour; 'oauth' drives the SDK OAuth flow. oauth_scope is
  // an optional requested scope string. OAuth client registration + tokens are
  // NOT stored here — they live encrypted in the OS keychain (secure store).
  (db) => {
    const cols = db.prepare("PRAGMA table_info(mcp_servers)").all() as { name: string }[];
    if (!cols.some((c) => c.name === "auth_mode")) {
      db.exec("ALTER TABLE mcp_servers ADD COLUMN auth_mode TEXT NOT NULL DEFAULT 'none'");
    }
    if (!cols.some((c) => c.name === "oauth_scope")) {
      db.exec("ALTER TABLE mcp_servers ADD COLUMN oauth_scope TEXT");
    }
  },

  // v24: per-tool enable/disable for MCP servers. disabled_tools is a JSON array
  // of raw (un-namespaced) tool names the user has switched off for this server,
  // applied workspace-wide. Empty array = all tools enabled (the default).
  (db) => {
    const cols = db.prepare("PRAGMA table_info(mcp_servers)").all() as { name: string }[];
    if (!cols.some((c) => c.name === "disabled_tools")) {
      db.exec("ALTER TABLE mcp_servers ADD COLUMN disabled_tools TEXT NOT NULL DEFAULT '[]'");
    }
  },

  // v25: Mobile sync foundation (docs/plans/mobile-app-viability.md Phase 1).
  //
  // Adds, to every syncable table:
  //   - hlc        TEXT : Hybrid Logical Clock stamp of the row's last write
  //                       (the last-writer-wins key; skew-safe, monotonic).
  //   - deleted_at TEXT : tombstone. NULL = live. Sync NEVER hard-deletes, so
  //                       deletions propagate instead of resurrecting.
  // Plus timestamps on `tags` (which had none, making tag changes invisible to
  // any diff), and the engine's bookkeeping tables:
  //   - sync_oplog    : append-only, HLC-ordered local change log.
  //   - sync_pending  : raw change staging populated by capture triggers (v26);
  //                     drained into sync_oplog with HLC stamps by the engine.
  //   - sync_state    : device_id + this device's HLC + per-peer watermarks.
  //
  // Proven in the Phase 0 spike (shared/sync/*). This migration is additive
  // and backward-compatible; the desktop keeps working unchanged.
  (db) => {
    const SYNCABLE = SYNCABLE_V25_V26;
    const colNames = (t: string) =>
      (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);

    // tags has no timestamps at all — add them.
    const tagCols = colNames("tags");
    if (!tagCols.includes("created_at")) db.exec("ALTER TABLE tags ADD COLUMN created_at TEXT");
    if (!tagCols.includes("updated_at")) db.exec("ALTER TABLE tags ADD COLUMN updated_at TEXT");

    for (const t of SYNCABLE) {
      const cols = colNames(t);
      if (!cols.includes("hlc")) db.exec(`ALTER TABLE ${t} ADD COLUMN hlc TEXT`);
      if (!cols.includes("deleted_at")) db.exec(`ALTER TABLE ${t} ADD COLUMN deleted_at TEXT`);
    }

    db.exec(`
      CREATE TABLE IF NOT EXISTS sync_oplog (
        seq        INTEGER PRIMARY KEY AUTOINCREMENT,
        hlc        TEXT NOT NULL,
        origin     TEXT NOT NULL,
        entity     TEXT NOT NULL,
        entity_id  TEXT NOT NULL,
        op         TEXT NOT NULL,          -- 'put' | 'delete'
        payload    TEXT,                   -- JSON row snapshot for 'put'
        applied_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_oplog_hlc    ON sync_oplog(hlc);
      CREATE INDEX IF NOT EXISTS idx_oplog_entity ON sync_oplog(entity, entity_id);

      CREATE TABLE IF NOT EXISTS sync_pending (
        seq       INTEGER PRIMARY KEY AUTOINCREMENT,
        entity    TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        op        TEXT NOT NULL            -- 'put' | 'delete'
      );

      CREATE TABLE IF NOT EXISTS sync_state (
        key   TEXT PRIMARY KEY,            -- 'device_id' | 'hlc' | 'watermark:<peer>'
        value TEXT NOT NULL
      );
    `);
  },

  // v26: Capture triggers. Every INSERT/UPDATE/DELETE on a syncable table stages
  // a row in sync_pending, regardless of which code path wrote it (renderer IPC,
  // MCP tools, or the file-watcher). The engine drains sync_pending into the
  // HLC-stamped sync_oplog. Trigger writes made by the engine itself are marked
  // via the `sync_state` key 'suppress' to avoid re-capturing applied remote ops.
  (db) => {
    // Guard: skip capturing changes the engine makes while applying remote ops.
    // A trigger checks whether the 'suppress' flag is set (value '1').
    const suppressGuard = `(SELECT COALESCE((SELECT value FROM sync_state WHERE key='suppress'),'0')) = '0'`;
    const SYNCABLE = SYNCABLE_V25_V26;
    for (const t of SYNCABLE) {
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS trg_sync_${t}_ins AFTER INSERT ON ${t}
        WHEN ${suppressGuard}
        BEGIN
          INSERT INTO sync_pending (entity, entity_id, op) VALUES ('${t}', NEW.id, 'put');
        END;

        CREATE TRIGGER IF NOT EXISTS trg_sync_${t}_upd AFTER UPDATE ON ${t}
        WHEN ${suppressGuard}
        BEGIN
          INSERT INTO sync_pending (entity, entity_id, op)
          VALUES ('${t}', NEW.id, CASE WHEN NEW.deleted_at IS NOT NULL THEN 'delete' ELSE 'put' END);
        END;

        CREATE TRIGGER IF NOT EXISTS trg_sync_${t}_del AFTER DELETE ON ${t}
        WHEN ${suppressGuard}
        BEGIN
          INSERT INTO sync_pending (entity, entity_id, op) VALUES ('${t}', OLD.id, 'delete');
        END;
      `);
    }
  },

  // v27: task_embeddings — semantic search over task cards. A PARALLEL table
  // (not a `kind` column on note_embeddings) because note_embeddings has a
  // FK+cascade to notes(id) and a composite PK; reusing it for cards would
  // require an FK-relaxing table rebuild and risk the notes path. This keeps the
  // notes pipeline untouched. Same column shape as note_embeddings minus the
  // graph-projection fields (dim_x/dim_y/proj_stale) — task search doesn't
  // project into the knowledge graph.
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS task_embeddings (
        card_id        TEXT NOT NULL REFERENCES task_cards(id) ON DELETE CASCADE,
        section_idx    INTEGER NOT NULL DEFAULT 0,
        workspace_id   TEXT NOT NULL,
        model          TEXT NOT NULL,
        task           TEXT NOT NULL,
        section_title  TEXT NOT NULL DEFAULT '',
        content_hash   TEXT NOT NULL,
        vector         TEXT NOT NULL,
        embedded_at    TEXT NOT NULL,
        PRIMARY KEY (card_id, section_idx)
      );
      CREATE INDEX IF NOT EXISTS idx_task_emb_workspace ON task_embeddings(workspace_id);
      CREATE INDEX IF NOT EXISTS idx_task_emb_task ON task_embeddings(task);
    `);
  },

  // v28: stop syncing chat. chat_threads/chat_messages were wrongly included in
  // the synced-table set (v25/v26), so every AI conversation replicated across
  // devices and dominated the oplog — hundreds of chat `put` ops re-applied on
  // every sync (the "applied=1802 / pending never settles" reports). Chat is an
  // online-only, device-local surface (docs/plans/mobile-app-viability.md §5.1,
  // §7.3); mobile already keeps a separate local-only `chat_local` table.
  //
  // This migration:
  //   1. Drops the chat capture triggers created by v26 so new chat writes no
  //      longer stage into sync_pending.
  //   2. Purges chat rows already sitting in sync_pending and sync_oplog so they
  //      stop being drained/published/re-applied. (The chat tables themselves are
  //      untouched — your chat history stays intact locally.)
  (db) => {
    for (const t of ["chat_threads", "chat_messages"]) {
      db.exec(`
        DROP TRIGGER IF EXISTS trg_sync_${t}_ins;
        DROP TRIGGER IF EXISTS trg_sync_${t}_upd;
        DROP TRIGGER IF EXISTS trg_sync_${t}_del;
      `);
      db.prepare("DELETE FROM sync_pending WHERE entity = ?").run(t);
      db.prepare("DELETE FROM sync_oplog WHERE entity = ?").run(t);
    }
  },

  // v29: Subagent chat mode. `chat_threads.use_subagents` persists the per-thread
  // toggle that routes a conversation through the dispatch → research/write
  // subagent loop; `chat_messages.subagents` (JSON) persists the expandable
  // subagent traces so they survive restarts (mirrors v14 tool_calls / v20 reasoning).
  (db) => {
    const threadCols = db.prepare("PRAGMA table_info(chat_threads)").all() as { name: string }[];
    if (!threadCols.some((c) => c.name === "use_subagents")) {
      db.exec("ALTER TABLE chat_threads ADD COLUMN use_subagents INTEGER NOT NULL DEFAULT 0");
    }
    const msgCols = db.prepare("PRAGMA table_info(chat_messages)").all() as { name: string }[];
    if (!msgCols.some((c) => c.name === "subagents")) {
      db.exec("ALTER TABLE chat_messages ADD COLUMN subagents TEXT");
    }
  },

  // v30: OAuth for custom HTTP services. Mirrors v23 (MCP OAuth) for the service
  // table: auth_mode 'none' keeps the existing static/keychain-header behaviour;
  // 'oauth' drives the transport-independent OAuth flow (browser sign-in, tokens
  // auto-refreshed and injected as Authorization: Bearer). oauth_config is an
  // optional JSON blob {serverUrl?, scope?, clientId?, authorizationUrl?, tokenUrl?}
  // for vendors needing a preconfigured client. Tokens/registration are NOT stored
  // here — they live encrypted in the OS keychain (secure store, namespace "service").
  (db) => {
    const cols = db.prepare("PRAGMA table_info(custom_services)").all() as { name: string }[];
    if (!cols.some((c) => c.name === "auth_mode")) {
      db.exec("ALTER TABLE custom_services ADD COLUMN auth_mode TEXT NOT NULL DEFAULT 'none'");
    }
    if (!cols.some((c) => c.name === "oauth_config")) {
      db.exec("ALTER TABLE custom_services ADD COLUMN oauth_config TEXT");
    }
  },

  // v31: User-defined & community slash commands. Workspace-global custom
  // commands that surface in the chat / agent input palettes. Built-in commands
  // stay as code constants; only custom + community-installed commands persist
  // here. `scope` picks which pane(s) show the command; `source` records
  // provenance ('custom' | 'community'); `community_id` links an installed
  // command back to its cairn-community manifest entry. Device-local (not synced)
  // — commands are a workspace-authoring convenience, not user data.
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS slash_commands (
        id           TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        name         TEXT NOT NULL,
        description  TEXT NOT NULL DEFAULT '',
        insert_text  TEXT NOT NULL DEFAULT '',
        scope        TEXT NOT NULL DEFAULT 'both',   -- 'chat' | 'agent' | 'both'
        source       TEXT NOT NULL DEFAULT 'custom', -- 'custom' | 'community'
        community_id TEXT,
        created_at   TEXT NOT NULL,
        updated_at   TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_slash_commands_workspace ON slash_commands(workspace_id);
    `);
  },

  // v32: Heartbeat automations — scheduled / recurring background agent tasks.
  // `automations` holds the schedule + replayed instructions + per-automation
  // standing rules; `automation_runs` records each fire (the independent,
  // resumable thread a run executes in). Device-local (not synced) — automations
  // are a workspace-authoring convenience, mirroring slash_commands / pi-agent
  // sessions. Schedule kinds: 'cron' (5-field), 'every' ("N unit"), 'once' (ISO
  // datetime). next_run_at is an ISO string indexed for cheap due() lookups.
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS automations (
        id              TEXT PRIMARY KEY,
        workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        project_id      TEXT REFERENCES projects(id) ON DELETE CASCADE,
        name            TEXT NOT NULL,
        description     TEXT NOT NULL DEFAULT '',
        instructions    TEXT NOT NULL,                 -- prompt replayed every run
        schedule_kind   TEXT NOT NULL DEFAULT 'every', -- 'cron' | 'every' | 'once'
        schedule_expr   TEXT NOT NULL,                 -- cron expr | "N unit" | ISO datetime
        timezone        TEXT,                          -- optional IANA timezone
        next_run_at     TEXT NOT NULL,                 -- ISO-8601
        enabled         INTEGER NOT NULL DEFAULT 1,
        max_runs        INTEGER,                       -- optional cap; NULL = unlimited
        run_count       INTEGER NOT NULL DEFAULT 0,
        approval_mode   TEXT NOT NULL DEFAULT 'auto',  -- 'auto' (run writes freely) | 'ask' (gate writes behind the approval inbox)
        standing_rules  TEXT NOT NULL DEFAULT '[]',    -- JSON [{tool, target}]
        source          TEXT NOT NULL DEFAULT 'custom',-- 'custom' | 'community'
        community_id    TEXT,
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_automations_next_run  ON automations(next_run_at);
      CREATE INDEX IF NOT EXISTS idx_automations_workspace ON automations(workspace_id);

      CREATE TABLE IF NOT EXISTS automation_runs (
        id             TEXT PRIMARY KEY,
        automation_id  TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
        status         TEXT NOT NULL DEFAULT 'pending', -- 'pending'|'running'|'done'|'denied'|'error'|'skipped'
        result_note_id TEXT,                            -- note delivered by a successful run (nullable)
        started_at     TEXT NOT NULL,
        finished_at    TEXT,
        error          TEXT,
        scratch        TEXT,                            -- JSON cross-run memory
        created_at     TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_automation_runs_automation ON automation_runs(automation_id);
      CREATE INDEX IF NOT EXISTS idx_automation_runs_status     ON automation_runs(status);
    `);
  },

  // v33: Durable approval inbox (OpenWorker inbox.py + hermes/openclaw approval
  // gate). A persisted, cross-session human-attention queue. Background runs park
  // a consequential action here and WAIT; the user approves/denies from the
  // renderer (survives renderer reload + tray-time). Semantics: resolve-once,
  // idempotent per (run_id, tool, args-hash), fail-closed timeout handled by the
  // runner. `state` pending → resolved/expired; `resolution` records the choice
  // (approved_once / approved_session / approved_always / denied).
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS approval_items (
        id         TEXT PRIMARY KEY,
        run_id     TEXT,                          -- automation_run id (nullable for interactive sessions)
        session_id TEXT,                          -- pi-agent session id (nullable)
        tool       TEXT NOT NULL,
        args       TEXT NOT NULL DEFAULT '{}',    -- JSON tool arguments (redacted where sensitive)
        args_hash  TEXT NOT NULL DEFAULT '',      -- idempotency key: sha1(tool + args)
        kind       TEXT NOT NULL DEFAULT 'approval', -- 'approval' | 'question' | 'notification' | 'plan'
        title      TEXT NOT NULL DEFAULT '',
        body       TEXT NOT NULL DEFAULT '',
        state      TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'resolved' | 'expired'
        resolution TEXT,                          -- 'approved_once' | 'approved_session' | 'approved_always' | 'denied'
        created_at TEXT NOT NULL,
        resolved_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_approval_items_state ON approval_items(state);
      CREATE INDEX IF NOT EXISTS idx_approval_items_run   ON approval_items(run_id);
    `);
  },

  // v34: Sync Phase 1 delete-wins metadata. `sync_row_base` remains the
  // common-ancestor store for note conflict detection and now also owns durable
  // delete/current-put causal metadata independently of domain tombstone rows.
  // `observed` carries exact target-delete observations authored with each op.
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS sync_row_base (
        entity       TEXT NOT NULL,
        entity_id    TEXT NOT NULL,
        base_body    TEXT,
        delete_hlc   TEXT,
        delete_origin TEXT,
        put_hlc      TEXT,
        put_observed TEXT,
        PRIMARY KEY (entity, entity_id)
      );
    `);
    const baseCols = (db.prepare("PRAGMA table_info(sync_row_base)").all() as { name: string }[]).map((c) => c.name);
    for (const [name, ddl] of [
      ["base_body", "base_body TEXT"],
      ["delete_hlc", "delete_hlc TEXT"],
      ["delete_origin", "delete_origin TEXT"],
      ["put_hlc", "put_hlc TEXT"],
      ["put_observed", "put_observed TEXT"],
    ] as const) {
      if (!baseCols.includes(name)) db.exec(`ALTER TABLE sync_row_base ADD COLUMN ${ddl}`);
    }
    const oplogCols = (db.prepare("PRAGMA table_info(sync_oplog)").all() as { name: string }[]).map((c) => c.name);
    if (!oplogCols.includes("observed")) db.exec("ALTER TABLE sync_oplog ADD COLUMN observed TEXT");
  },

  // v35: Connector-aware automations — `automations.requires` column
  // (JSON [{kind:'mcp'|'service', name}], NULL = data-only recipe). Added
  // AFTER v32 shipped so databases already at v32+ (which ran the automations
  // CREATE TABLE without this column) get it appended here, idempotently.
  (db) => {
    const cols = (db.prepare("PRAGMA table_info(automations)").all() as { name: string }[]).map((c) => c.name);
    if (!cols.includes("requires")) db.exec("ALTER TABLE automations ADD COLUMN requires TEXT");
  },

  // v36: Pre-registered OAuth client for remote MCP servers (e.g. Slack's MCP
  // server, which forbids dynamic client registration). oauth_client_id is a
  // PUBLIC client id (never a secret); oauth_redirect_uri is a fixed loopback
  // URL the provider requires pre-registered (e.g.
  // http://127.0.0.1:<port>/callback). Auth stays public-PKCE — no secret is
  // stored. Both nullable — existing public-PKCE/DCR servers work unchanged.
  (db) => {
    const cols = (db.prepare("PRAGMA table_info(mcp_servers)").all() as { name: string }[]).map((c) => c.name);
    if (!cols.includes("oauth_client_id")) db.exec("ALTER TABLE mcp_servers ADD COLUMN oauth_client_id TEXT");
    if (!cols.includes("oauth_redirect_uri")) db.exec("ALTER TABLE mcp_servers ADD COLUMN oauth_redirect_uri TEXT");
  },

  // v37: Pre-registered-app marker for remote MCP servers. oauth_client_id_required
  // is true when the provider forbids dynamic client registration (e.g. Slack),
  // so the UI prompts for the client id / redirect URI before sign-in instead of
  // failing on DCR. Set by community connectors (`requiresClientId`); the form
  // exposes it as a "requires a pre-registered app" toggle.
  (db) => {
    const cols = (db.prepare("PRAGMA table_info(mcp_servers)").all() as { name: string }[]).map((c) => c.name);
    if (!cols.includes("oauth_client_id_required")) {
      db.exec("ALTER TABLE mcp_servers ADD COLUMN oauth_client_id_required INTEGER NOT NULL DEFAULT 0");
    }
  },

  // v38: LLM usage log — append-only per-request token/cost record backing the
  // Usage view. Written at every LLM capture point (chat tool loop, pi agent,
  // subagents, automations, one-shot AI features) via electron/lib/usage-recorder.ts.
  // `created_at` is epoch ms (INTEGER) so the per-day bucketing can use the
  // user's local timezone in SQL. `workspace_id`/`project_id` are nullable —
  // one-shot features (commit message, explain, tool builder) may not belong to
  // a workspace; NULL rows are treated as global when scoping the view.
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS llm_usage (
        id                TEXT PRIMARY KEY,
        workspace_id      TEXT,
        project_id        TEXT,
        source            TEXT NOT NULL,
        session_id        TEXT,
        provider          TEXT,
        model             TEXT NOT NULL,
        base_url          TEXT,
        prompt_tokens     INTEGER NOT NULL DEFAULT 0,
        completion_tokens INTEGER NOT NULL DEFAULT 0,
        reasoning_tokens  INTEGER NOT NULL DEFAULT 0,
        cost_usd          REAL,
        cost_estimated    INTEGER NOT NULL DEFAULT 0,
        finish_reason     TEXT,
        created_at        INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_llm_usage_created   ON llm_usage(created_at);
      CREATE INDEX IF NOT EXISTS idx_llm_usage_source    ON llm_usage(source);
      CREATE INDEX IF NOT EXISTS idx_llm_usage_model     ON llm_usage(model);
      CREATE INDEX IF NOT EXISTS idx_llm_usage_workspace ON llm_usage(workspace_id, created_at);
    `);
  },
];

export function applySchema(db: Database.Database): void {
  // PRAGMA foreign_keys must be set per connection — do it first, before exec.
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);
  runMigrations(db);
  ensureColumns(db);
}

/**
 * Idempotent, version-independent column guards. Migrations only run for
 * `user_version` values below MIGRATIONS.length, so a DB whose user_version was
 * already advanced past a migration index (e.g. by an interim/renumbered build)
 * can miss a column even though its version looks current. This defensively
 * ensures late-added columns exist on every connection, regardless of version.
 * Each check is a no-op once the column is present.
 */
function ensureColumns(db: Database.Database): void {
  const ensure = (table: string, column: string, ddl: string) => {
    try {
      const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
      if (cols.length > 0 && !cols.some((c) => c.name === column)) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
      }
    } catch {
      /* table may not exist on some connections — safe to skip */
    }
  };
  ensure("chat_threads", "use_subagents", "use_subagents INTEGER NOT NULL DEFAULT 0");
  ensure("chat_messages", "subagents", "subagents TEXT");
  ensure("automations", "approval_mode", "approval_mode TEXT NOT NULL DEFAULT 'auto'");
  ensure("automations", "active_hours_start", "active_hours_start TEXT");
  ensure("automations", "active_hours_end", "active_hours_end TEXT");
  ensure("automations", "requires", "requires TEXT");
  ensure("mcp_notifications", "target_type", "target_type TEXT");
  ensure("mcp_notifications", "target_id", "target_id TEXT");
  ensure("custom_services", "auth_mode", "auth_mode TEXT NOT NULL DEFAULT 'none'");
  ensure("custom_services", "oauth_config", "oauth_config TEXT");
  // Multi-operation services: baseUrl + operations[] (JSON). Nullable — legacy
  // single-op rows leave them empty and use api_url/method/tool_definition.
  ensure("custom_services", "base_url", "base_url TEXT");
  ensure("custom_services", "operations", "operations TEXT");
  // Pre-registered OAuth client for MCP servers (v36) — late-added columns
  // survive even if a DB's user_version was advanced past the migration by an
  // interim build.
  ensure("mcp_servers", "oauth_client_id", "oauth_client_id TEXT");
  ensure("mcp_servers", "oauth_redirect_uri", "oauth_redirect_uri TEXT");
  ensure("mcp_servers", "oauth_client_id_required", "oauth_client_id_required INTEGER NOT NULL DEFAULT 0");
  // v38 llm_usage — cost_estimated added after the initial table shipped in an
  // interim build; existing dev DBs get the column here, fresh ones from v38.
  ensure("llm_usage", "cost_estimated", "cost_estimated INTEGER NOT NULL DEFAULT 0");
  // Prompt-cache token counts (cache_read/cache_creation) added for cache-hit
  // tracking — additive, so a guard rather than a new migration is enough.
  ensure("llm_usage", "cache_read_tokens", "cache_read_tokens INTEGER NOT NULL DEFAULT 0");
  ensure("llm_usage", "cache_creation_tokens", "cache_creation_tokens INTEGER NOT NULL DEFAULT 0");
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
