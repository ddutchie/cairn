/**
 * Mobile database bootstrap + sync engine singleton.
 *
 * Opens the local expo-sqlite DB, applies the syncable schema + capture
 * triggers, and constructs the shared SyncEngine over the expo-sqlite adapter.
 */

import * as SQLite from "expo-sqlite";
import { SyncEngine } from "@cairn/shared/sync/engine";
import { createExpoSyncDb } from "./expo-sync-db";
import { MOBILE_SCHEMA_SQL, MOBILE_TRIGGERS_SQL } from "./schema";

const DB_NAME = "cairn-mobile.db";

let _db: SQLite.SQLiteDatabase | null = null;
let _engine: SyncEngine | null = null;

/** Stable per-install device id for HLC + oplog origin. Persisted in sync_state. */
function ensureDeviceId(db: SQLite.SQLiteDatabase): string {
  const row = db.getFirstSync<{ value: string }>(
    "SELECT value FROM sync_state WHERE key = 'device_id'",
  );
  if (row?.value) return row.value;
  const id = `mobile_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
  db.runSync(
    "INSERT INTO sync_state (key, value) VALUES ('device_id', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    id,
  );
  return id;
}

export function initDatabase(): { db: SQLite.SQLiteDatabase; engine: SyncEngine } {
  if (_db && _engine) return { db: _db, engine: _engine };

  const db = SQLite.openDatabaseSync(DB_NAME);
  db.execSync(MOBILE_SCHEMA_SQL);
  db.execSync(MOBILE_TRIGGERS_SQL);

  const deviceId = ensureDeviceId(db);
  const adapter = createExpoSyncDb(db);
  const engine = new SyncEngine(adapter, deviceId);

  _db = db;
  _engine = engine;
  return { db, engine };
}

export function getDb(): SQLite.SQLiteDatabase {
  if (!_db) throw new Error("DB not initialised — call initDatabase() first");
  return _db;
}

export function getEngine(): SyncEngine {
  if (!_engine) throw new Error("Sync engine not initialised — call initDatabase() first");
  return _engine;
}
