/**
 * Relationship-cache maintenance for MCP writes.
 *
 * `relationship_cache` has no FK, so deleting a project's notes/cards would
 * orphan their cached edges. `delete_project` therefore has to capture those
 * entity ids BEFORE the cascade delete and invalidate them afterwards — that's
 * what `collectPreDeleteEntityIds` + the executeTool wrapper do. These tests
 * cover the collection and the end-to-end invalidation.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import BetterSqlite3 from "better-sqlite3";
import type Database from "better-sqlite3";
import { applySchema } from "../../db/schema";
import { createWorkspace, createProject, createNote, createCard, createColumn } from "../../db/queries";
import { collectPreDeleteEntityIds } from "./relationships";
import { executeTool } from "./index";

let tmpDir: string;
let db: Database.Database;

function seedCacheRow(sourceId: string, targetId: string) {
  db.prepare(
    "INSERT INTO relationship_cache (source_id, target_id, type, weight, computed_at) VALUES (?, ?, 'co-mention', 1.0, ?)",
  ).run(sourceId, targetId, Math.floor(Date.now() / 1000));
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-rel-test-"));
  db = new BetterSqlite3(":memory:");
  applySchema(db);
  createWorkspace(db, { id: "ws1", name: "WS" });
  createProject(db, { id: "proj1", workspaceId: "ws1", name: "Project One" });
  createProject(db, { id: "proj2", workspaceId: "ws1", name: "Project Two" });
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("collectPreDeleteEntityIds", () => {
  it("collects a project's note and card ids for delete_project", () => {
    const note = createNote(db, { id: "note-a", workspaceId: "ws1", projectId: "proj1", title: "N", content: "x" });
    const col = createColumn(db, { id: "col-a", workspaceId: "ws1", projectId: "proj1", name: "Todo", type: "todo" });
    const card = createCard(db, { id: "card-a", workspaceId: "ws1", projectId: "proj1", columnId: col.id, title: "C" });

    const ids = collectPreDeleteEntityIds(db, "delete_project", { projectId: "proj1" });

    expect(ids).toContain(note.id);
    expect(ids).toContain(card.id);
  });

  it("returns [] for tools that are not delete_project", () => {
    expect(collectPreDeleteEntityIds(db, "ensure_note", { noteId: "n1" })).toEqual([]);
  });

  it("returns [] when projectId is missing", () => {
    expect(collectPreDeleteEntityIds(db, "delete_project", {})).toEqual([]);
  });
});

describe("delete_project invalidates the deleted entities' relationship cache", () => {
  it("removes cache rows referencing the deleted project's notes/cards", () => {
    const note = createNote(db, { id: "note-orphan", workspaceId: "ws1", projectId: "proj1", title: "Orphan", content: "x" });
    // A surviving note in another project that co-mentions the doomed one.
    const survivor = createNote(db, { id: "note-survivor", workspaceId: "ws1", projectId: "proj2", title: "Survivor", content: "y" });
    seedCacheRow(note.id, survivor.id);

    // Sanity: the edge exists before the delete.
    const before = db
      .prepare("SELECT COUNT(*) AS n FROM relationship_cache WHERE source_id = ? OR target_id = ?")
      .get(note.id, note.id) as { n: number };
    expect(before.n).toBe(1);

    const result = executeTool(db, tmpDir, "delete_project", { projectId: "proj1" });
    expect(result && typeof result === "object" && "error" in (result as object)).toBe(false);

    // The doomed note is gone AND its cache edge was invalidated.
    const after = db
      .prepare("SELECT COUNT(*) AS n FROM relationship_cache WHERE source_id = ? OR target_id = ?")
      .get(note.id, note.id) as { n: number };
    expect(after.n).toBe(0);
  });
});
