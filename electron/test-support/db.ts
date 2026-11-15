/**
 * Shared SQLite test fixtures (A1). Every Electron test that needs an
 * isolated database imports `makeDb` from here instead of declaring its own —
 * the 15 copies were byte-identical, so this is a pure move.
 *
 * Tests with special schema needs (migration chains, pre-seeded workspaces)
 * keep their own builders; `electron/agent/` fixtures stay in
 * `electron/agent/test-harness.ts` (C1).
 */
import BetterSqlite3 from "better-sqlite3";
import type Database from "better-sqlite3";
import { applySchema } from "../db/schema";
import { createProject, createWorkspace } from "../db/workspace-queries";

/** Fresh in-memory DB with the full schema applied. Caller owns `db.close()`. */
export function makeDb(): Database.Database {
  const db = new BetterSqlite3(":memory:");
  applySchema(db);
  return db;
}

/** One workspace row (`ws1` / "Test Workspace" by default). */
export function seedWorkspace(db: Database.Database, id = "ws1", name = "Test Workspace") {
  return createWorkspace(db, { id, name });
}

/** One project row (`proj1` in `ws1` by default). */
export function seedProject(
  db: Database.Database,
  workspaceId = "ws1",
  id = "proj1",
  name = "Test Project",
) {
  return createProject(db, { id, workspaceId, name });
}
