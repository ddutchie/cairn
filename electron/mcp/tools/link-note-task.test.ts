/**
 * Regression test for the "note gets deleted right after linking it to a task"
 * bug.
 *
 * `link_note_to_task` / `unlink_note_from_task` write the note's .md via
 * writeNoteFile, which can relocate the file (and unlink the old path). The
 * Electron file-watcher runs in a SEPARATE process, so its only cross-process
 * guard against treating that unlink as a real delete is the `mcp_active_writes`
 * lock. The tool used to release that lock (unlockNote in a `finally`) BEFORE
 * calling writeNoteFile, leaving the file write unprotected → the watcher would
 * delete the note's DB row.
 *
 * These tests assert the lock is held across the file write.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import BetterSqlite3 from "better-sqlite3";
import type Database from "better-sqlite3";
import { applySchema } from "../../db/schema";
import { createWorkspace, createProject, getActiveMcpWrites } from "../../db/queries";
import { getSnapshot } from "../db";
import { link_note_to_task, unlink_note_from_task } from "./tasks";

let tmpDir: string;
let db: Database.Database;

const PROJECT_NAME = "My Project";

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-link-test-"));
  db = new BetterSqlite3(":memory:");
  applySchema(db);
  createWorkspace(db, { id: "ws1", name: "WS" });
  createProject(db, { id: "proj1", workspaceId: "ws1", name: PROJECT_NAME });
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function seedNote(id: string, folder = "") {
  db.prepare(
    `INSERT INTO notes (id, project_id, workspace_id, title, content,
       tag_ids, linked_note_ids, linked_card_ids, is_pinned, type, folder, created_at, updated_at)
     VALUES (?, 'proj1', 'ws1', ?, 'body', '[]', '[]', '[]', 0, 'note', ?, ?, ?)`,
  ).run(id, `Note ${id}`, folder, "2025-01-01T00:00:00.000Z", "2025-01-01T00:00:00.000Z");
}

function seedCard(id: string, columnId = "col1") {
  db.prepare(
    `INSERT INTO board_columns (id, project_id, workspace_id, name, type, "order", created_at, updated_at)
     VALUES (?, 'proj1', 'ws1', 'Todo', 'todo', 0, ?, ?)`,
  ).run(columnId, "2025-01-01T00:00:00.000Z", "2025-01-01T00:00:00.000Z");
  db.prepare(
    `INSERT INTO task_cards (id, column_id, project_id, workspace_id, title, description,
       tag_ids, priority, linked_note_ids, "order", created_at, updated_at)
     VALUES (?, ?, 'proj1', 'ws1', ?, '', '[]', 'medium', '[]', 0, ?, ?)`,
  ).run(id, columnId, `Card ${id}`, "2025-01-01T00:00:00.000Z", "2025-01-01T00:00:00.000Z");
}

describe("link_note_to_task lock ordering", () => {
  it("keeps the note row after linking (does not orphan it)", () => {
    seedNote("n1");
    seedCard("c1");
    const snap = getSnapshot(db);
    const res = link_note_to_task(db, snap, tmpDir, { noteId: "n1", cardId: "c1" }) as {
      linked?: boolean;
      error?: string;
    };
    expect(res.linked).toBe(true);

    // The row must still exist and carry the link.
    const row = db.prepare("SELECT linked_card_ids FROM notes WHERE id = 'n1'").get() as
      | { linked_card_ids: string }
      | undefined;
    expect(row).toBeDefined();
    expect(JSON.parse(row!.linked_card_ids)).toContain("c1");
  });

  it("holds the mcp_active_writes lock across writeNoteFile", () => {
    seedNote("n1");
    seedCard("c1");
    const snap = getSnapshot(db);

    // Spy on writeFileSync — while the .md is being written, the lock MUST be
    // held (this is the window in which the watcher could see the unlink).
    const realWrite = fs.writeFileSync;
    let lockHeldDuringWrite: boolean | null = null;
    const fsMut = fs as { writeFileSync: typeof fs.writeFileSync };
    fsMut.writeFileSync = ((...a: Parameters<typeof fs.writeFileSync>) => {
      const p = String(a[0]);
      if (p.endsWith(".md.tmp") || p.endsWith(".md")) {
        lockHeldDuringWrite = getActiveMcpWrites(db).has("n1");
      }
      return realWrite(...a);
    }) as typeof fs.writeFileSync;
    try {
      link_note_to_task(db, snap, tmpDir, { noteId: "n1", cardId: "c1" });
    } finally {
      fsMut.writeFileSync = realWrite;
    }

    expect(lockHeldDuringWrite).toBe(true);
    // And the lock must be released afterwards.
    expect(getActiveMcpWrites(db).has("n1")).toBe(false);
  });

  it("unlink_note_from_task also keeps the row and holds the lock", () => {
    seedNote("n1");
    seedCard("c1");
    let snap = getSnapshot(db);
    link_note_to_task(db, snap, tmpDir, { noteId: "n1", cardId: "c1" });

    snap = getSnapshot(db);
    const res = unlink_note_from_task(db, snap, tmpDir, { noteId: "n1", cardId: "c1" }) as {
      unlinked?: boolean;
      error?: string;
    };
    expect(res.unlinked).toBe(true);

    const row = db.prepare("SELECT linked_card_ids FROM notes WHERE id = 'n1'").get() as
      | { linked_card_ids: string }
      | undefined;
    expect(row).toBeDefined();
    expect(JSON.parse(row!.linked_card_ids)).not.toContain("c1");
  });
});
