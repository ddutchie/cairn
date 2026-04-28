/**
 * Cairn — SQLite client singleton (Electron main process)
 *
 * Opens (or creates) the database at the Electron userData path.
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
// In dev:  dist-electron/main.js → __dirname = <project>/dist-electron
//          → ../electron-native/better_sqlite3_electron.node
// In prod: packaged asar → use process.resourcesPath which points at
//          Contents/Resources where electron-native/ is unpacked.
const ELECTRON_BINDING = app.isPackaged
  ? path.join(process.resourcesPath, "electron-native", "better_sqlite3_electron.node")
  : path.join(__dirname, "..", "electron-native", "better_sqlite3_electron.node");

let _db: Database.Database | null = null;

export function initDb(userDataPath: string): Database.Database {
  const dbDir = path.join(userDataPath, "cairn");
  fs.mkdirSync(dbDir, { recursive: true });

  const dbPath = path.join(dbDir, "cairn.db");
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
