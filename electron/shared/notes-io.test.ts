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

  it("keeps the filename on a bare title change (Obsidian wikilink safety)", () => {
    // Filename-stability policy: a title change alone is metadata — the .md must
    // NOT be renamed (that would break Obsidian [[wikilinks]], which resolve by
    // filename). Renaming is opt-in via renameFile (see next test).
    writeNoteFile(tmpDir, BASE);
    const oldFp = path.join(tmpDir, "My Project", "My Note.md");
    expect(fs.existsSync(oldFp)).toBe(true);

    writeNoteFile(tmpDir, { ...BASE, title: "Renamed Note" });

    // Same file, new title in frontmatter, filename unchanged.
    expect(fs.existsSync(oldFp)).toBe(true);
    expect(fs.readdirSync(path.join(tmpDir, "My Project"))).toEqual(["My Note.md"]);
    const contents = fs.readFileSync(oldFp, "utf-8");
    expect(contents).toContain("title: Renamed Note");
    expect(contents).toContain("Hello body.");
  });

  it("relocates when renameFile is set, removing the old file (explicit rename)", () => {
    writeNoteFile(tmpDir, BASE);
    const oldFp = path.join(tmpDir, "My Project", "My Note.md");
    expect(fs.existsSync(oldFp)).toBe(true);

    writeNoteFile(tmpDir, { ...BASE, title: "Renamed Note", renameFile: true });

    const newFp = path.join(tmpDir, "My Project", "Renamed Note.md");
    expect(fs.existsSync(newFp)).toBe(true);
    expect(fs.existsSync(oldFp)).toBe(false); // old path cleaned up
    expect(fs.readFileSync(newFp, "utf-8")).toContain("Hello body.");
  });

  it("handles a case-only folder difference per filesystem semantics", () => {
    // The note's .md lives in an on-disk "research" directory, but a later write
    // supplies folder "Research" (differs only in case). Behaviour must follow
    // the filesystem:
    //   • case-INSENSITIVE FS (macOS/Windows): the two paths alias the same
    //     inode → in-place rewrite, file preserved (this was the data-loss bug).
    //   • case-SENSITIVE FS (Linux): they are genuinely different files → a real
    //     relocation, with no stale case-folded duplicate left behind.
    writeNoteFile(tmpDir, { ...BASE, folder: "research" });
    const lowerFp = path.join(tmpDir, "My Project", "research", "My Note.md");
    const upperFp = path.join(tmpDir, "My Project", "Research", "My Note.md");
    expect(fs.existsSync(lowerFp)).toBe(true);
    const inoBefore = fs.statSync(lowerFp).ino;

    // Detect aliasing BEFORE the second write: does the case-variant path
    // resolve to the same file the lowercase one does?
    const aliased =
      fs.existsSync(upperFp) &&
      fs.realpathSync.native(lowerFp) === fs.realpathSync.native(upperFp);

    writeNoteFile(tmpDir, { ...BASE, folder: "Research", linkedCardIds: ["c1"] });

    if (aliased) {
      // Case-insensitive FS: same file, rewritten in place (inode unchanged),
      // content + link metadata preserved. No second directory materialises.
      expect(fs.existsSync(lowerFp)).toBe(true);
      expect(fs.statSync(lowerFp).ino).toBe(inoBefore);
      const contents = fs.readFileSync(lowerFp, "utf-8");
      expect(contents).toContain("Hello body.");
      expect(contents).toContain("c1");
    } else {
      // Case-sensitive FS: relocated to the new-cased directory, old file gone,
      // and no leftover duplicate under the old "research" directory.
      expect(fs.existsSync(upperFp)).toBe(true);
      expect(fs.existsSync(lowerFp)).toBe(false);
      const contents = fs.readFileSync(upperFp, "utf-8");
      expect(contents).toContain("Hello body.");
      expect(contents).toContain("c1");
    }
  });
});
