import Database from "better-sqlite3";
import { findDbPath } from "../electron/mcp/db";
import { applySchema } from "../electron/db/schema";
import path from "path";
import fs from "fs";

const dbPath = findDbPath();
if (!dbPath) {
  console.error("Database path not found! Make sure you have opened the Cairn app at least once.");
  process.exit(1);
}
console.log("Found database at:", dbPath);

// Load the vitest-native compiled native binary to match System Node version
const nativeBinding = path.join(__dirname, "..", "vitest-native", "better_sqlite3.node");
const options = fs.existsSync(nativeBinding) ? { nativeBinding } : {};

const db = new Database(dbPath, options);
console.log("Applying migrations...");
applySchema(db);
console.log("Migrations applied successfully!");
db.close();
