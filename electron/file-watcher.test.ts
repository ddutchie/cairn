/**
 * Unit tests for electron/file-watcher.ts — the `shouldDeleteOnUnlink`
 * decision that distinguishes a real external note deletion from a
 * relocation / in-flight write.
 *
 * Regression coverage for the "notes vanish when moved between folders / when
 * created into an existing folder" bugs: an `unlink` fired for the OLD path of
 * a relocated note must NOT delete the row while the file lives on elsewhere or
 * while an MCP-side write is in flight.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import BetterSqlite3 from "better-sqlite3";
import type Database from "better-sqlite3";
import { applySchema } from "./db/schema";
import { createWorkspace, createProject } from "./db/queries";
import { writeNoteFile } from "./notes-files";
import { shouldDeleteOnUnlink, __setWorkspacePathForTest } from "./file-watcher";

let tmpDir: string;
let db: Database.Database;

const PROJECT_NAME = "My Project";

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-fw-test-"));
  db = new BetterSqlite3(":memory:");
  applySchema(db);
  createWorkspace(db, { id: "ws1", name: "WS" });
  createProject(db, { id: "proj1", workspaceId: "ws1", name: PROJECT_NAME });
  __setWorkspacePathForTest(tmpDir);
});

afterEach(() => {
  __setWorkspacePathForTest(null);
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function seedNoteRow(id: string, folder = "") {
  db.prepare(
    `INSERT INTO notes (id, project_id, workspace_id, title, content, content_text,
       tag_ids, linked_note_ids, linked_card_ids, is_pinned, type, folder, created_at, updated_at)
     VALUES (?, 'proj1', 'ws1', ?, '', '', '[]', '[]', '[]', 0, 'note', ?, ?, ?)`,
  ).run(id, `Note ${id}`, folder, "2025-01-01T00:00:00.000Z", "2025-01-01T00:00:00.000Z");
}

function writeFile(id: string, title: string, folder = "") {
  writeNoteFile(tmpDir, {
    id, projectId: "proj1", workspaceId: "ws1", title, content: "body",
    tagIds: [], linkedNoteIds: [], linkedCardIds: [], isPinned: false,
    folder, createdAt: "2025-01-01T00:00:00.000Z", updatedAt: "2025-01-01T00:00:00.000Z",
    projectName: PROJECT_NAME,
  });
}

describe("shouldDeleteOnUnlink", () => {
  it("returns true for a genuine external delete (row exists, no file on disk)", () => {
    seedNoteRow("n1");
    // No .md written for n1 anywhere → file really gone → real delete.
    expect(shouldDeleteOnUnlink(db, "n1")).toBe(true);
  });

  it("returns false when the note's file still exists elsewhere (relocation)", () => {
    seedNoteRow("n1", "target");
    // Simulate a folder move: the note's .md now lives under the NEW folder,
    // while the OLD path's unlink event is being processed.
    writeFile("n1", "Note n1", "target");
    expect(shouldDeleteOnUnlink(db, "n1")).toBe(false);
  });

  it("returns false while an MCP-side write is in flight (mcp_active_writes)", () => {
    seedNoteRow("n1");
    // No file on disk yet, but the write is in flight — must not delete.
    db.prepare(
      "INSERT OR REPLACE INTO mcp_active_writes (note_id, started_at) VALUES (?, datetime('now'))",
    ).run("n1");
    expect(shouldDeleteOnUnlink(db, "n1")).toBe(false);
  });

  it("returns true once the in-flight write clears and no file remains", () => {
    seedNoteRow("n1");
    db.prepare(
      "INSERT OR REPLACE INTO mcp_active_writes (note_id, started_at) VALUES (?, datetime('now'))",
    ).run("n1");
    expect(shouldDeleteOnUnlink(db, "n1")).toBe(false);
    db.prepare("DELETE FROM mcp_active_writes WHERE note_id = ?").run("n1");
    expect(shouldDeleteOnUnlink(db, "n1")).toBe(true);
  });

  it("finds the file via the full-tree fallback when the DB folder is out of sync with disk", () => {
    // DB row says the note is at root, but the file actually lives in a
    // subfolder (row/disk temporarily out of sync). The fast path (expected
    // dir = root) misses; the recursive fallback must still find it → no delete.
    seedNoteRow("n1", "");
    writeFile("n1", "Note n1", "Elsewhere");
    expect(shouldDeleteOnUnlink(db, "n1")).toBe(false);
  });
});
