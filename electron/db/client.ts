/**
 * Cairn — SQLite client singleton (Electron main process)
 *
 * Opens (or creates) the database at the given absolute path.
 * The path is now resolved in main.ts based on the user-chosen workspace folder.
 * Call initDb() once from main.ts before any IPC handlers are registered.
 *
 * Passes the Electron-ABI binary via the `nativeBinding` option so the
 * system-Node binary in node_modules/ stays intact for the MCP server.
 * Both can open the same .db file concurrently — SQLite WAL mode handles it.
 */

import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import { app } from "electron";
import { applySchema } from "./schema";

// Path to the Electron-ABI native binary (built with electron-rebuild).
// In dev:  __dirname = <project>/dist-electron  →  ../electron-native/
// In prod: binary is in app.asar.unpacked/electron-native/ (listed in asarUnpack)
//          process.resourcesPath = Contents/Resources
const ELECTRON_BINDING = app.isPackaged
  ? path.join(process.resourcesPath, "app.asar.unpacked", "electron-native", "better_sqlite3_electron.node")
  : path.join(__dirname, "..", "electron-native", "better_sqlite3_electron.node");

let _db: Database.Database | null = null;

export function initDb(dbPath: string): Database.Database {
  // Ensure the parent directory exists
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  // nativeBinding tells better-sqlite3 to use our Electron-ABI .node file
  // instead of the one it would find via `bindings` (the system-Node build).
  const db = new Database(dbPath, { nativeBinding: ELECTRON_BINDING } as ConstructorParameters<typeof Database>[1]);

  // Apply schema (idempotent — uses CREATE IF NOT EXISTS)
  applySchema(db);

  _db = db;
  return db;
}

export function getDb(): Database.Database {
  if (!_db) throw new Error("DB not initialised — call initDb() first");
  return _db;
}
