/**
 * Mobile schema migrations.
 *
 * The base schema (schema.ts) is create-if-not-exists, which can't evolve an
 * existing install. This adds a versioned path: `PRAGMA user_version` tracks the
 * applied version, and any migration whose index is above it runs in order.
 *
 * To evolve the schema: bump nothing by hand — just append an entry to
 * MIGRATIONS. Each entry runs exactly once per device, in order. Keep them
 * idempotent where cheap (IF NOT EXISTS) so a partially-applied upgrade is safe.
 */

import type * as SQLite from "expo-sqlite";

/**
 * Ordered migrations. Index N (0-based) becomes user_version N+1 once applied.
 * v1 is implicitly the base schema (schema.ts) — start real migrations at the
 * next entry. NEVER edit or reorder existing entries; only append.
 */
const MIGRATIONS: ((db: SQLite.SQLiteDatabase) => void)[] = [
  // v2: local-only on-device semantic-search index (see schema.ts). No capture
  // trigger — never syncs. Fresh installs already have this from the base
  // schema; this back-fills existing installs.
  (db) =>
    db.execSync(`
      CREATE TABLE IF NOT EXISTS note_embeddings (
        note_id       TEXT NOT NULL,
        section_idx   INTEGER NOT NULL DEFAULT 0,
        workspace_id  TEXT NOT NULL DEFAULT '',
        model         TEXT NOT NULL DEFAULT '',
        section_title TEXT NOT NULL DEFAULT '',
        content_hash  TEXT NOT NULL DEFAULT '',
        vector        TEXT NOT NULL DEFAULT '[]',
        embedded_at   TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (note_id, section_idx)
      );
      CREATE INDEX IF NOT EXISTS idx_note_emb_note ON note_embeddings(note_id);
    `),
  // v3: task-card embedding index (semantic task search). Fresh installs have it
  // from the base schema; this back-fills existing installs.
  (db) =>
    db.execSync(`
      CREATE TABLE IF NOT EXISTS task_embeddings (
        card_id       TEXT NOT NULL,
        section_idx   INTEGER NOT NULL DEFAULT 0,
        workspace_id  TEXT NOT NULL DEFAULT '',
        model         TEXT NOT NULL DEFAULT '',
        section_title TEXT NOT NULL DEFAULT '',
        content_hash  TEXT NOT NULL DEFAULT '',
        vector        TEXT NOT NULL DEFAULT '[]',
        embedded_at   TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (card_id, section_idx)
      );
      CREATE INDEX IF NOT EXISTS idx_task_emb_card ON task_embeddings(card_id);
      CREATE INDEX IF NOT EXISTS idx_task_emb_ws ON task_embeddings(workspace_id);
    `),
  // v4: stop syncing chat. chat_threads/chat_messages were wrongly part of the
  // synced set, so the desktop replicated every AI conversation into the oplog
  // and this device received + re-applied hundreds of chat puts on every sync
  // (mirrors desktop migration v28). Chat is online-only + device-local; mobile
  // already keeps its own local `chat_local` table. Drop the chat capture
  // triggers created from the old SYNCABLE_TABLES list and purge chat rows from
  // the sync buffers. The chat_threads/chat_messages tables (received from the
  // desktop) are left as-is; they're just no longer synced.
  (db) => {
    for (const t of ["chat_threads", "chat_messages"]) {
      db.execSync(`
        DROP TRIGGER IF EXISTS trg_sync_${t}_ins;
        DROP TRIGGER IF EXISTS trg_sync_${t}_upd;
        DROP TRIGGER IF EXISTS trg_sync_${t}_del;
        DELETE FROM sync_pending WHERE entity = '${t}';
        DELETE FROM sync_oplog WHERE entity = '${t}';
      `);
    }
  },
];

/** The schema version this build expects (base schema = 1, plus each migration). */
export const MOBILE_SCHEMA_VERSION = 1 + MIGRATIONS.length;

/**
 * Run pending migrations. Assumes the base schema has already been applied
 * (execSync of MOBILE_SCHEMA_SQL). Fresh installs jump straight to the latest
 * version (base schema already includes every current column), so only existing
 * installs from an older build run the intermediate ALTERs.
 */
export function runMigrations(db: SQLite.SQLiteDatabase): void {
  const row = db.getFirstSync<{ user_version: number }>("PRAGMA user_version");
  let version = row?.user_version ?? 0;

  // A brand-new DB (version 0) has just had the full base schema applied, so
  // it's already at the latest shape — stamp it and skip the back-migrations.
  if (version === 0) {
    db.execSync(`PRAGMA user_version = ${MOBILE_SCHEMA_VERSION}`);
    return;
  }

  // Existing install: apply any migrations newer than its recorded version.
  // Migration index i upgrades version (i+1) -> (i+2).
  for (let i = version - 1; i < MIGRATIONS.length; i++) {
    if (i < 0) continue;
    MIGRATIONS[i](db);
    version = i + 2;
    db.execSync(`PRAGMA user_version = ${version}`);
  }
}
