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
import { writeNoteFile, deleteProjectNotesDir, deleteNoteFile, hardDeleteNoteFile, setPathRemover, type NoteFileData, type PathRemover } from "./notes-io";

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

/**
 * Regression tests for the project-delete data-loss bug.
 *
 * Project note folders on disk are keyed by the project NAME slug, not the id,
 * and project names are NOT unique. So two projects sharing a name (e.g. a
 * duplicate "Personal" created by a timed-out+retried request) share one
 * folder. Deleting one used to `fs.rmSync` the shared folder unconditionally,
 * destroying the survivor's .md files. deleteProjectNotesDir must skip the
 * delete when a surviving project still occupies the same slug.
 */
describe("deleteProjectNotesDir slug-collision guard", () => {
  it("removes the folder when no other project shares the slug", () => {
    const dir = path.join(tmpDir, "Personal");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "note.md"), "keep me");

    deleteProjectNotesDir(tmpDir, "Personal", []);

    expect(fs.existsSync(dir)).toBe(false);
  });

  it("does NOT remove the folder when a surviving project shares the slug", () => {
    const dir = path.join(tmpDir, "Personal");
    fs.mkdirSync(dir, { recursive: true });
    const fp = path.join(dir, "note.md");
    fs.writeFileSync(fp, "another project's data");

    // A same-named duplicate still exists → the shared folder must be preserved.
    deleteProjectNotesDir(tmpDir, "Personal", ["Personal"]);

    expect(fs.existsSync(fp)).toBe(true);
    expect(fs.readFileSync(fp, "utf-8")).toBe("another project's data");
  });

  it("guards on the slug, not the exact name (spacing variants collide)", () => {
    // "My  Project" (double space) and "My Project" both slugify to "My Project".
    const dir = path.join(tmpDir, "My Project");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "note.md"), "data");

    deleteProjectNotesDir(tmpDir, "My Project", ["My  Project"]);

    expect(fs.existsSync(dir)).toBe(true);
  });

  it("is a no-op when the folder does not exist", () => {
    expect(() => deleteProjectNotesDir(tmpDir, "Nonexistent", [])).not.toThrow();
  });
});

/**
 * The Electron main process routes deletes to the OS trash via setPathRemover
 * (shell.trashItem) so notes/projects are restorable. The MCP process (no
 * Electron shell) keeps the default hard fs delete. These tests verify the
 * injection point without depending on a real desktop trash.
 */
describe("setPathRemover — pluggable trash vs hard delete", () => {
  afterEach(() => setPathRemover()); // always reset to the fs default

  it("routes note-file deletes through the injected remover", () => {
    writeNoteFile(tmpDir, BASE);
    const fp = path.join(tmpDir, "My Project", "My Note.md");
    expect(fs.existsSync(fp)).toBe(true);

    const trashed: string[] = [];
    const remover: PathRemover = (target) => { trashed.push(target); };
    setPathRemover(remover);

    deleteNoteFile(tmpDir, BASE.projectName!, BASE.id);

    // The injected remover was called with the note's path; because our fake
    // remover doesn't actually delete, the file is still on disk (proving the
    // hard fs.unlinkSync no longer runs directly).
    expect(trashed).toEqual([fp]);
    expect(fs.existsSync(fp)).toBe(true);
  });

  it("routes project-folder deletes through the injected remover", () => {
    const dir = path.join(tmpDir, "My Project");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "note.md"), "data");

    const trashed: string[] = [];
    setPathRemover((target) => { trashed.push(target); });

    deleteProjectNotesDir(tmpDir, "My Project", []);

    expect(trashed).toEqual([dir]);
    expect(fs.existsSync(dir)).toBe(true); // fake remover didn't delete
  });

  it("falls back to a hard delete when the remover throws", () => {
    writeNoteFile(tmpDir, BASE);
    const fp = path.join(tmpDir, "My Project", "My Note.md");

    setPathRemover(() => { throw new Error("trash unavailable"); });

    deleteNoteFile(tmpDir, BASE.projectName!, BASE.id);

    // Fallback fs delete ran → file is gone despite the trasher failing.
    expect(fs.existsSync(fp)).toBe(false);
  });

  it("hard-deletes by default (MCP process, no shell injected)", () => {
    writeNoteFile(tmpDir, BASE);
    const fp = path.join(tmpDir, "My Project", "My Note.md");

    // No setPathRemover call → default hardRemove.
    deleteNoteFile(tmpDir, BASE.projectName!, BASE.id);

    expect(fs.existsSync(fp)).toBe(false);
  });

  it("falls back to a hard delete when an ASYNC remover rejects", async () => {
    writeNoteFile(tmpDir, BASE);
    const fp = path.join(tmpDir, "My Project", "My Note.md");

    // Async trasher that rejects (e.g. shell.trashItem unavailable). removePath
    // wraps it in a promise whose .catch performs the hard-delete fallback.
    const remover: PathRemover = () => Promise.reject(new Error("no trash"));
    setPathRemover(remover);

    deleteNoteFile(tmpDir, BASE.projectName!, BASE.id);

    // Removal completes asynchronously — flush the microtask queue, then assert
    // the fallback fs delete ran.
    await new Promise((r) => setTimeout(r, 0));
    expect(fs.existsSync(fp)).toBe(false);
  });
});

describe("hardDeleteNoteFile — sync delete that bypasses the OS-trash remover", () => {
  afterEach(() => setPathRemover());

  it("deletes synchronously even when an async trasher is injected", () => {
    writeNoteFile(tmpDir, BASE);
    const fp = path.join(tmpDir, "My Project", "My Note.md");

    // An injected (async, fire-and-forget) trasher must NOT be used for the
    // move-internal cleanup — hardDeleteNoteFile always does a sync fs delete so
    // the stale old-project copy is gone before the move handler returns.
    const trashed: string[] = [];
    setPathRemover((t) => { trashed.push(t); return Promise.resolve(); });

    hardDeleteNoteFile(tmpDir, BASE.projectName!, BASE.id);

    expect(trashed).toEqual([]);            // trasher untouched
    expect(fs.existsSync(fp)).toBe(false);  // file gone synchronously
  });
});
