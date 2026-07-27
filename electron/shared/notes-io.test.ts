/**
 * Regression tests for writeNoteFile's write strategy.
 *
 * The "note deleted right after linking to a task" data-loss bug came from a
 * metadata-only write (link_note_to_task) rewriting the note's .md via tmp-file
 * + rename. A rename-over-an-existing-file changes the inode, which chokidar
 * reports as unlink+add of the note's own path; the cross-process
 * mcp_active_writes lock can already be released by the time that unlink is
 * delivered, so the file-watcher tombstones the note row.
 *
 * writeNoteFile must therefore write IN PLACE (no rename) when the file's path
 * is unchanged, and only use tmp+rename for a genuine relocation.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { writeNoteFile, type NoteFileData } from "./notes-io";

let tmpDir: string;

const BASE: NoteFileData = {
  id: "n1",
  projectId: "proj1",
  workspaceId: "ws1",
  title: "My Note",
  content: "Hello body.",
  tagIds: [],
  linkedNoteIds: [],
  linkedCardIds: [],
  isPinned: false,
  folder: "",
  createdAt: "2025-01-01T00:00:00.000Z",
  updatedAt: "2025-01-01T00:00:00.000Z",
  projectName: "My Project",
};

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-notesio-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("writeNoteFile write strategy", () => {
  it("writes a new note directly at its path", () => {
    writeNoteFile(tmpDir, BASE);
    const fp = path.join(tmpDir, "My Project", "My Note.md");
    expect(fs.existsSync(fp)).toBe(true);
    expect(fs.readFileSync(fp, "utf-8")).toContain("Hello body.");
  });

  it("does NOT rename (no unlink event) on a same-path metadata rewrite", () => {
    writeNoteFile(tmpDir, BASE);
    const fp = path.join(tmpDir, "My Project", "My Note.md");
    const inoBefore = fs.statSync(fp).ino;

    // A link-style update: same title/folder → same path, only linkedCardIds change.
    writeNoteFile(tmpDir, { ...BASE, linkedCardIds: ["c1"] });

    // The whole point of the fix: a same-path rewrite must be IN PLACE, so the
    // inode is unchanged (a tmp+rename would replace the inode → chokidar
    // unlink → cross-process delete race). No new/other files either.
    const inoAfter = fs.statSync(fp).ino;
    expect(inoAfter).toBe(inoBefore);
    expect(fs.readdirSync(path.join(tmpDir, "My Project"))).toEqual(["My Note.md"]);

    const contents = fs.readFileSync(fp, "utf-8");
    expect(contents).toContain("Hello body."); // content preserved
    expect(contents).toContain("c1"); // link metadata written
    // No stray backup file left behind after a successful in-place write.
    expect(fs.readdirSync(path.join(tmpDir, "My Project"))).toEqual(["My Note.md"]);
  });

  it("preserves the original note if an in-place rewrite fails mid-write", () => {
    writeNoteFile(tmpDir, BASE);
    const fp = path.join(tmpDir, "My Project", "My Note.md");
    const original = fs.readFileSync(fp, "utf-8");

    // Simulate a crash during the in-place write: the fd write throws.
    const realWrite = fs.writeFileSync;
    const spy = vi.spyOn(fs, "writeFileSync").mockImplementation(((target: unknown, ...rest: unknown[]) => {
      // Only fail the fd write (numeric fd), not the .bak copy (which uses copyFileSync).
      if (typeof target === "number") throw new Error("disk full");
      return (realWrite as (...a: unknown[]) => unknown)(target, ...rest);
    }) as typeof fs.writeFileSync);

    try {
      expect(() => writeNoteFile(tmpDir, { ...BASE, content: "corrupt-me" })).toThrow();
    } finally {
      spy.mockRestore();
    }

    // The note must still hold its original bytes (restored from backup), and no
    // .bak artifact should linger.
    expect(fs.readFileSync(fp, "utf-8")).toBe(original);
    expect(fs.readdirSync(path.join(tmpDir, "My Project"))).toEqual(["My Note.md"]);
  });

  it("relocates when the title changes, removing the old file", () => {
    writeNoteFile(tmpDir, BASE);
    const oldFp = path.join(tmpDir, "My Project", "My Note.md");
    expect(fs.existsSync(oldFp)).toBe(true);

    writeNoteFile(tmpDir, { ...BASE, title: "Renamed Note" });

    const newFp = path.join(tmpDir, "My Project", "Renamed Note.md");
    expect(fs.existsSync(newFp)).toBe(true);
    expect(fs.existsSync(oldFp)).toBe(false); // old path cleaned up
    expect(fs.readFileSync(newFp, "utf-8")).toContain("Hello body.");
  });

  it("does not delete the note when the folder differs only by case", () => {
    // Reproduces the data-loss bug: a note stored under folder "Research" whose
    // .md lives in the on-disk directory "research". On a case-insensitive FS
    // the recomputed path differs only in case, so a metadata-only write must
    // NOT be treated as a relocation (which would unlink the file it rewrote).
    writeNoteFile(tmpDir, { ...BASE, folder: "research" });
    const fp = path.join(tmpDir, "My Project", "research", "My Note.md");
    expect(fs.existsSync(fp)).toBe(true);
    const inoBefore = fs.statSync(fp).ino;

    // A link-style write with the folder cased differently ("Research").
    writeNoteFile(tmpDir, { ...BASE, folder: "Research", linkedCardIds: ["c1"] });

    // The file must survive (case-insensitive FS: same inode, still present),
    // and no differently-cased sibling directory/file should be orphaned.
    expect(fs.existsSync(fp)).toBe(true);
    const contents = fs.readFileSync(fp, "utf-8");
    expect(contents).toContain("Hello body.");
    expect(contents).toContain("c1");
    // On a case-insensitive FS the inode is unchanged (true in-place write).
    if (fs.existsSync(fp)) {
      expect(fs.statSync(fp).ino).toBe(inoBefore);
    }
  });
});
