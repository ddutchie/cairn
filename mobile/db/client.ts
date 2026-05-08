/**
 * Cairn Mobile — expo-sqlite DB client
 *
 * Opens the Cairn workspace SQLite file from a user-configured path
 * (typically an iCloud Drive location synced with the desktop app).
 *
 * On first launch, the user picks the workspace folder via the onboarding
 * screen and the path is persisted in AsyncStorage under STORAGE_KEYS.DB_PATH.
 *
 * The schema is identical to the desktop (electron/db/schema.ts). We run
 * the same migrations (translated to expo-sqlite API) so the mobile app
 * can open a DB created by the desktop without any conversion.
 */

import * as SQLite from "expo-sqlite";
import { SCHEMA_SQL, runMigrations } from "./schema";

let _db: SQLite.SQLiteDatabase | null = null;

export function getDb(): SQLite.SQLiteDatabase {
  if (!_db) throw new Error("DB not initialised — call openDb() first");
  return _db;
}

export async function openDb(dbPath: string): Promise<SQLite.SQLiteDatabase> {
  // expo-sqlite v16 opens by filename; for a custom path we use the
  // SQLiteDatabase.openDatabaseAsync with a full absolute path.
  const db = await SQLite.openDatabaseAsync(dbPath, {
    useNewConnection: false,
  });

  // WAL mode for concurrent read + write (matches desktop config)
  await db.execAsync("PRAGMA journal_mode = WAL;");
  await db.execAsync("PRAGMA foreign_keys = ON;");

  // Apply base schema (idempotent — CREATE TABLE IF NOT EXISTS)
  await db.execAsync(SCHEMA_SQL);

  // Apply versioned migrations
  await runMigrations(db);

  _db = db;
  return db;
}

export async function closeDb(): Promise<void> {
  if (_db) {
    await _db.closeAsync();
    _db = null;
  }
}
