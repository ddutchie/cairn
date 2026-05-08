/**
 * Cairn Mobile — expo-sqlite DB client
 *
 * expo-sqlite v16 (SDK 55) API:
 *   openDatabaseAsync(filename, options?, directory?)
 *
 * - For the demo/local workspace: filename = "workspace.db", directory = default
 * - For an iCloud-synced workspace: filename = "workspace.db", directory = the
 *   chosen iCloud folder path
 *
 * We store both the filename and directory separately in AsyncStorage so we can
 * reconstruct the call on app restart.
 */

import * as SQLite from "expo-sqlite";
import { SCHEMA_SQL, runMigrations } from "./schema";

let _db: SQLite.SQLiteDatabase | null = null;

export function getDb(): SQLite.SQLiteDatabase {
  if (!_db) throw new Error("DB not initialised — call openDb() first");
  return _db;
}

/**
 * Open (or create) the workspace database.
 *
 * @param filename  Just the filename, e.g. "workspace.db"
 * @param directory Optional directory path. Omit to use expo-sqlite's default
 *                  app-private location. Pass the iCloud folder path for sync.
 */
export async function openDb(
  filename: string,
  directory?: string
): Promise<SQLite.SQLiteDatabase> {
  const db = await SQLite.openDatabaseAsync(filename, {}, directory);

  await db.execAsync("PRAGMA journal_mode = WAL;");
  await db.execAsync("PRAGMA foreign_keys = ON;");
  await db.execAsync(SCHEMA_SQL);
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
