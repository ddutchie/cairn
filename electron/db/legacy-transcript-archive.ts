/**
 * Cairn — one-shot archive of the pre-Cordis SQLite transcript tables.
 *
 * Runs from migration v49 (electron/db/schema.ts) exactly once per DB.
 * Before this branch, `chat_messages`, `pi_agent_messages`,
 * `pi_agent_llm_history` and `approval_items` held real user data. The
 * Cordis runtime moved chat + coding-agent transcripts to the dsh JSONL
 * session log, so those tables are no longer written. But EXISTING users
 * upgrading from 2.7.6 have populated rows we cannot just DROP — the sidebar
 * still lists every `chat_threads` / `pi_agent_sessions` row, so every
 * pre-cutover conversation would appear empty (indistinguishable from data
 * corruption).
 *
 * This module dumps each non-empty legacy table to a NDJSON file under
 * `<workspacePath>/.cairn/archive/2.7.7/` before the migration DROPs it, so
 * the data survives (as a plain-text backup, not app-loaded) and the user
 * can be pointed at a real archive. Fresh installs have empty (or absent)
 * tables so the dump is a no-op.
 *
 * Idempotent: guarded by `PRAGMA user_version` (only runs once), and the
 * dump files are written with a timestamp suffix, so a second run (e.g.
 * after restoring an old DB) creates a fresh dump alongside the first
 * instead of overwriting it.
 */

import fs from "fs";
import path from "path";
import type Database from "better-sqlite3";

const LEGACY_TABLES = [
  "chat_messages",
  "pi_agent_messages",
  "pi_agent_llm_history",
  "approval_items",
] as const;

export interface ArchiveResult {
  archivedTables: Array<{ table: string; rows: number; path: string }>;
  droppedTables: string[];
  archiveDir: string | null;
}

/**
 * Archive every populated LEGACY_TABLES row to NDJSON and DROP the tables.
 * Safe to call on a DB where the tables do not exist (fresh install).
 * Returns the list of tables archived + dropped so the caller can log/notify.
 */
export function archiveAndDropLegacyTranscripts(db: Database.Database): ArchiveResult {
  const result: ArchiveResult = {
    archivedTables: [],
    droppedTables: [],
    archiveDir: null,
  };

  // Resolve archive dir from the DB path. In production the DB lives at
  // <workspacePath>/cairn.db (see electron/main.ts:284, workspace-config.ts).
  // In tests / MCP contexts db.name may be ':memory:' — in that case we skip
  // the dump but still DROP the tables.
  const dbPath = db.name;
  const archiveDir =
    dbPath && dbPath !== ":memory:" && dbPath !== ""
      ? path.join(path.dirname(dbPath), ".cairn", "archive", "2.7.7")
      : null;

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");

  for (const table of LEGACY_TABLES) {
    let rows: Record<string, unknown>[] = [];
    let tableExists = true;
    try {
      // Cheap existence + shape probe. sqlite_master.type='table' guards
      // against a view of the same name; PRAGMA table_info is empty for a
      // missing table.
      const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
      if (cols.length === 0) {
        tableExists = false;
      } else {
        rows = db.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];
      }
    } catch {
      tableExists = false;
    }

    if (tableExists && rows.length > 0 && archiveDir) {
      try {
        fs.mkdirSync(archiveDir, { recursive: true });
        const outPath = path.join(archiveDir, `${table}-${stamp}.ndjson`);
        // NDJSON: one JSON object per line, no envelope. Cheap to grep,
        // trivial to re-import if we ever need to. Sync write so a migration
        // that returns has actually persisted the archive before the DROP
        // runs on the next line.
        const body = rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
        fs.writeFileSync(outPath, body);
        result.archivedTables.push({ table, rows: rows.length, path: outPath });
      } catch (err) {
        // If we cannot write the archive, DO NOT drop the table — better to
        // leave the DB with an unused table than to lose data silently. Re-
        // throw so the migration fails loudly and the user can inspect.
        throw new Error(
          `Failed to archive ${table} (${rows.length} rows) to ${archiveDir}: ${String((err as Error)?.message ?? err)}`,
        );
      }
    }

    if (tableExists) {
      try {
        db.prepare(`DROP TABLE IF EXISTS ${table}`).run();
        result.droppedTables.push(table);
      } catch {
        /* best-effort — the migration is idempotent, a later boot will retry */
      }
    }
  }

  if (result.archivedTables.length > 0 && archiveDir) {
    result.archiveDir = archiveDir;
  }

  return result;
}

/**
 * Boot notification helper: format a one-line summary the app can show once
 * to the user (main-process console log + a splash toast, ideally). Returns
 * null when nothing was archived, so the caller can skip the notice for
 * fresh installs / already-upgraded DBs.
 */
export function formatArchiveNotice(result: ArchiveResult): string | null {
  if (result.archivedTables.length === 0) return null;
  const totalRows = result.archivedTables.reduce((n, e) => n + e.rows, 0);
  const tables = result.archivedTables.map((e) => `${e.table} (${e.rows})`).join(", ");
  return `Legacy chat/agent history archived: ${totalRows} rows across ${tables} → ${result.archiveDir}`;
}
