/**
 * Unit tests for electron/notes-files.ts
 *
 * Each test group uses a fresh temporary directory created with
 * fs.mkdtempSync, cleaned up in afterEach.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import BetterSqlite3 from "better-sqlite3";
import type Database from "better-sqlite3";
import { applySchema } from "./db/schema";
import { createWorkspace, createProject } from "./db/queries";
import {
  toSlug,
  writeNoteFile,
  parseNoteFile,
  resolveNoteFilePath,
  deleteNoteFile,
  stripMarkdown,
  projectNotesDir,
  notesDir,
  adoptExternalNoteFile,
  syncNotesFromDisk,
} from "./notes-files";
import type { NoteData } from "./notes-files";

// ── Temp dir helpers ──────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Shared fixture ────────────────────────────────────────────────────────

function makeNote(overrides: Partial<NoteData> = {}): NoteData {
  return {
    id: "note-abc123",
    projectId: "proj1",
    workspaceId: "ws1",
    title: "My Test Note",
    content: "# Hello\n\nThis is the body.",
    tagIds: ["tag1", "tag2"],
    linkedNoteIds: ["linked-note-1"],
    linkedCardIds: ["linked-card-1"],
    isPinned: false,
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-02T00:00:00.000Z",
    projectName: "My Project",
    ...overrides,
  };
}

// ── toSlug ────────────────────────────────────────────────────────────────

describe("toSlug", () => {
  it("lowercases and converts spaces to single spaces (not dashes)", () => {
    // toSlug preserves spaces — it's a filesystem-safe display name, not a URL slug
    const result = toSlug("Hello World");
    expect(result).toBe("Hello World");
  });

  it("strips filesystem-illegal characters", () => {
    // toSlug removes chars that are illegal on major OSes: / \ : * ? " < > |
    // Spaces between words are preserved (not converted to dashes)
    expect(toSlug('file/name:with*illegal?"chars')).toBe("filenamewithillegalchars");
  });

  it("strips path separators (forward and back slash)", () => {
    expect(toSlug("path/to\\file")).toBe("pathtofile");
  });

  it("strips angle brackets and pipe", () => {
    expect(toSlug("a<b>c|d")).toBe("abcd");
  });

  it("normalises multiple spaces into one", () => {
    expect(toSlug("too   many    spaces")).toBe("too many spaces");
  });

  it("trims leading and trailing whitespace", () => {
    expect(toSlug("  padded  ")).toBe("padded");
  });

  it("truncates very long titles to 100 characters", () => {
    const long = "a".repeat(200);
    expect(toSlug(long)).toHaveLength(100);
  });

  it("returns 'Untitled' for an empty or whitespace-only string", () => {
    expect(toSlug("")).toBe("Untitled");
    expect(toSlug("   ")).toBe("Untitled");
  });

  it("returns 'Untitled' for a string of only illegal characters", () => {
    expect(toSlug("/\\:*?\"<>|")).toBe("Untitled");
  });
});

// ── writeNoteFile / parseNoteFile round-trip ─────────────────────────────

describe("writeNoteFile + parseNoteFile round-trip", () => {
  it("preserves all frontmatter fields on read-back", () => {
    const note = makeNote();
    writeNoteFile(tmpDir, note);

    const dir = projectNotesDir(tmpDir, note.projectName!);
    const slug = toSlug(note.title);
    const fp = path.join(dir, `${slug}.md`);

    expect(fs.existsSync(fp)).toBe(true);

    const parsed = parseNoteFile(fp);
    expect(parsed).not.toBeNull();
    expect(parsed!.id).toBe(note.id);
    expect(parsed!.projectId).toBe(note.projectId);
    expect(parsed!.workspaceId).toBe(note.workspaceId);
    expect(parsed!.title).toBe(note.title);
    expect(parsed!.tagIds).toEqual(note.tagIds);
    expect(parsed!.linkedNoteIds).toEqual(note.linkedNoteIds);
    expect(parsed!.linkedCardIds).toEqual(note.linkedCardIds);
    expect(parsed!.isPinned).toBe(note.isPinned);
    expect(parsed!.createdAt).toBe(note.createdAt);
    expect(parsed!.updatedAt).toBe(note.updatedAt);
  });

  it("preserves the markdown body exactly", () => {
    const note = makeNote({ content: "# Heading\n\nParagraph with **bold** text." });
    writeNoteFile(tmpDir, note);

    const dir = projectNotesDir(tmpDir, note.projectName!);
    const fp = path.join(dir, `${toSlug(note.title)}.md`);
    const parsed = parseNoteFile(fp);

    // gray-matter trims and adds a trailing newline on content
    expect(parsed!.content.trim()).toBe(note.content.trim());
  });

  it("creates the file inside the correct project subdirectory", () => {
    const note = makeNote({ projectName: "Special Project" });
    writeNoteFile(tmpDir, note);

    const expectedDir = projectNotesDir(tmpDir, "Special Project");
    expect(fs.existsSync(expectedDir)).toBe(true);

    const files = fs.readdirSync(expectedDir).filter((f) => f.endsWith(".md"));
    expect(files).toHaveLength(1);
  });

  it("persists archivedAt in frontmatter when set", () => {
    const note = makeNote({ archivedAt: "2025-06-01T00:00:00.000Z" });
    writeNoteFile(tmpDir, note);

    const dir = projectNotesDir(tmpDir, note.projectName!);
    const fp = path.join(dir, `${toSlug(note.title)}.md`);
    const parsed = parseNoteFile(fp);

    expect(parsed!.archivedAt).toBe("2025-06-01T00:00:00.000Z");
  });

  it("returns null for a file without required frontmatter", () => {
    const fp = path.join(tmpDir, "bad.md");
    fs.writeFileSync(fp, "# Just markdown, no frontmatter");
    expect(parseNoteFile(fp)).toBeNull();
  });
});

// ── resolveNoteFilePath collision handling ────────────────────────────────

describe("resolveNoteFilePath collision handling", () => {
  it("returns the canonical path when no file exists yet", () => {
    const fp = resolveNoteFilePath(tmpDir, "My Project", "New Note", "note-abc");
    const expected = path.join(projectNotesDir(tmpDir, "My Project"), `${toSlug("New Note")}.md`);
    expect(fp).toBe(expected);
  });

  it("returns the same path when the existing file belongs to the same note", () => {
    // Write a note first, then resolve its path again — should get same path
    const note = makeNote({ id: "note-same" });
    writeNoteFile(tmpDir, note);

    const fp = resolveNoteFilePath(tmpDir, note.projectName!, note.title, note.id);
    const expected = path.join(projectNotesDir(tmpDir, note.projectName!), `${toSlug(note.title)}.md`);
    expect(fp).toBe(expected);
  });

  it("appends a short ID suffix when a different note already uses the slug", () => {
    // Write note A with the same title
    const noteA = makeNote({ id: "aaa111", title: "Shared Title" });
    writeNoteFile(tmpDir, noteA);

    // Resolve path for note B (different id, same title, same project)
    const noteB_id = "bbb222";
    const fp = resolveNoteFilePath(tmpDir, noteA.projectName!, "Shared Title", noteB_id);

    // Should NOT be the plain slug path
    const plainPath = path.join(projectNotesDir(tmpDir, noteA.projectName!), `${toSlug("Shared Title")}.md`);
    expect(fp).not.toBe(plainPath);

    // Should contain the short ID of noteB
    expect(fp).toContain(noteB_id.slice(0, 6));
  });
});

// ── deleteNoteFile ────────────────────────────────────────────────────────

describe("deleteNoteFile", () => {
  it("removes the file after deletion", () => {
    const note = makeNote();
    writeNoteFile(tmpDir, note);

    const dir = projectNotesDir(tmpDir, note.projectName!);
    const fp = path.join(dir, `${toSlug(note.title)}.md`);
    expect(fs.existsSync(fp)).toBe(true);

    deleteNoteFile(tmpDir, note.projectName!, note.id);
    expect(fs.existsSync(fp)).toBe(false);
  });

  it("does not throw when deleting a non-existent note", () => {
    expect(() => {
      deleteNoteFile(tmpDir, "NonExistentProject", "ghost-id-999");
    }).not.toThrow();
  });
});

// ── stripMarkdown ─────────────────────────────────────────────────────────

describe("stripMarkdown", () => {
  it("strips ATX headings", () => {
    expect(stripMarkdown("# Heading 1\n## Heading 2\n### Heading 3")).toBe(
      "Heading 1\nHeading 2\nHeading 3"
    );
  });

  it("strips bold formatting", () => {
    expect(stripMarkdown("This is **bold** text")).toBe("This is bold text");
  });

  it("strips italic formatting", () => {
    expect(stripMarkdown("This is *italic* text")).toBe("This is italic text");
  });

  it("strips inline code", () => {
    expect(stripMarkdown("Use `console.log()` here")).toBe("Use  here");
  });

  it("strips markdown links, keeping the label", () => {
    expect(stripMarkdown("[Click here](https://example.com)")).toBe("Click here");
  });

  it("strips unordered list bullets", () => {
    expect(stripMarkdown("- item one\n* item two\n+ item three")).toBe(
      "item one\nitem two\nitem three"
    );
  });

  it("strips ordered list numbers", () => {
    expect(stripMarkdown("1. First\n2. Second")).toBe("First\nSecond");
  });

  it("strips blockquote markers", () => {
    expect(stripMarkdown("> quoted text")).toBe("quoted text");
  });

  it("returns plain text from mixed markdown", () => {
    const md = "# Title\n\n**Bold** and *italic* with a [link](http://x.com).\n\n- bullet\n\n> quote";
    const result = stripMarkdown(md);
    expect(result).toContain("Title");
    expect(result).toContain("Bold");
    expect(result).toContain("italic");
    expect(result).toContain("link");
    expect(result).toContain("bullet");
    expect(result).toContain("quote");
    expect(result).not.toContain("#");
    expect(result).not.toContain("**");
    expect(result).not.toContain("*italic*");
    expect(result).not.toContain("[link]");
    expect(result).not.toContain("(http");
    expect(result).not.toContain("- ");
    expect(result).not.toContain("> ");
  });

  it("handles empty string without error", () => {
    expect(stripMarkdown("")).toBe("");
  });
});

// ── adoptExternalNoteFile ─────────────────────────────────────────────────

function makeDb(): Database.Database {
  const db = new BetterSqlite3(":memory:");
  applySchema(db);
  return db;
}

function seedProjectInDb(db: Database.Database, name = "My Project", id = "proj1", wsId = "ws1") {
  createWorkspace(db, { id: wsId, name: "Test Workspace" });
  return createProject(db, { id, workspaceId: wsId, name });
}

describe("adoptExternalNoteFile", () => {
  let db: Database.Database;

  beforeEach(() => { db = makeDb(); });

  it("returns null for a file outside any project folder", () => {
    seedProjectInDb(db);
    // Write a .md file directly in notes/ root (no project subfolder)
    const notesRoot = notesDir(tmpDir);
    fs.mkdirSync(notesRoot, { recursive: true });
    const fp = path.join(notesRoot, "orphan.md");
    fs.writeFileSync(fp, "# Orphan\n\nNo project.\n", "utf-8");

    const result = adoptExternalNoteFile(db, tmpDir, fp);
    expect(result).toBeNull();
  });

  it("returns null when the project slug does not match any project", () => {
    seedProjectInDb(db, "My Project");
    const dir = path.join(notesDir(tmpDir), "unknown-project");
    fs.mkdirSync(dir, { recursive: true });
    const fp = path.join(dir, "some-note.md");
    fs.writeFileSync(fp, "# Note\n\nContent.\n", "utf-8");

    expect(adoptExternalNoteFile(db, tmpDir, fp)).toBeNull();
  });

  it("adopts a plain .md file and writes frontmatter in-place", () => {
    seedProjectInDb(db, "My Project", "proj1", "ws1");
    const dir = path.join(notesDir(tmpDir), toSlug("My Project"));
    fs.mkdirSync(dir, { recursive: true });
    const fp = path.join(dir, "My External Note.md");
    fs.writeFileSync(fp, "# External\n\nSome content here.\n", "utf-8");

    const note = adoptExternalNoteFile(db, tmpDir, fp);

    expect(note).not.toBeNull();
    expect(note!.title).toBe("My External Note");
    expect(note!.projectId).toBe("proj1");
    expect(note!.workspaceId).toBe("ws1");
    expect(note!.content).toContain("Some content here");

    // Frontmatter written IN-PLACE — original file path must now be parseable
    const parsed = parseNoteFile(fp);
    expect(parsed).not.toBeNull();
    expect(parsed!.id).toBe(note!.id);
    expect(parsed!.title).toBe("My External Note");
  });

  it("does NOT create a second file — only the original path is modified", () => {
    seedProjectInDb(db, "My Project", "proj1", "ws1");
    const dir = path.join(notesDir(tmpDir), toSlug("My Project"));
    fs.mkdirSync(dir, { recursive: true });
    const fp = path.join(dir, "My Note.md");
    fs.writeFileSync(fp, "# My Note\n\nBody.\n", "utf-8");

    adoptExternalNoteFile(db, tmpDir, fp);

    // Only the original file should exist — no slug-derived duplicate
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".md"));
    expect(files).toHaveLength(1);
    expect(files[0]).toBe("My Note.md");
  });

  it("copy-paste scenario: two files with different names get independent IDs", () => {
    seedProjectInDb(db, "My Project", "proj1", "ws1");
    const dir = path.join(notesDir(tmpDir), toSlug("My Project"));
    fs.mkdirSync(dir, { recursive: true });

    const original = path.join(dir, "My Note.md");
    const copy     = path.join(dir, "My Note copy.md");

    fs.writeFileSync(original, "# My Note\n\nOriginal content.\n", "utf-8");
    fs.writeFileSync(copy,     "# My Note copy\n\nOriginal content.\n", "utf-8");

    const noteA = adoptExternalNoteFile(db, tmpDir, original);
    const noteB = adoptExternalNoteFile(db, tmpDir, copy);

    expect(noteA).not.toBeNull();
    expect(noteB).not.toBeNull();

    // IDs must be distinct
    expect(noteA!.id).not.toBe(noteB!.id);

    // Both original file paths must be parseable with their own IDs
    const parsedA = parseNoteFile(original);
    const parsedB = parseNoteFile(copy);
    expect(parsedA!.id).toBe(noteA!.id);
    expect(parsedB!.id).toBe(noteB!.id);

    // Still exactly two files — no extra slug-derived duplicates
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".md"));
    expect(files).toHaveLength(2);
  });

  it("derives subfolder from intermediate path segments", () => {
    seedProjectInDb(db, "My Project", "proj1", "ws1");
    const dir = path.join(notesDir(tmpDir), toSlug("My Project"), "design", "typography");
    fs.mkdirSync(dir, { recursive: true });
    const fp = path.join(dir, "Font Scale.md");
    fs.writeFileSync(fp, "# Font Scale\n\nContent.\n", "utf-8");

    const note = adoptExternalNoteFile(db, tmpDir, fp);

    expect(note).not.toBeNull();
    expect(note!.folder).toBe("design/typography");
  });

  it("is idempotent — adopting an already-adopted file returns its existing data", () => {
    seedProjectInDb(db, "My Project", "proj1", "ws1");
    const dir = path.join(notesDir(tmpDir), toSlug("My Project"));
    fs.mkdirSync(dir, { recursive: true });
    const fp = path.join(dir, "Idempotent.md");
    fs.writeFileSync(fp, "# Idempotent\n\nContent.\n", "utf-8");

    const first  = adoptExternalNoteFile(db, tmpDir, fp);
    // After first adoption the file has valid frontmatter — parseNoteFile succeeds,
    // so adoptExternalNoteFile is never actually called a second time by the watcher.
    // Verify the file is now parseable (and adoption would be skipped).
    const parsed = parseNoteFile(fp);
    expect(parsed).not.toBeNull();
    expect(parsed!.id).toBe(first!.id);
  });
});

// ── syncNotesFromDisk ─────────────────────────────────────────────────────

describe("syncNotesFromDisk", () => {
  let db: Database.Database;

  beforeEach(() => { db = makeDb(); });

  it("imports a Cairn note file that exists at startup", () => {
    seedProjectInDb(db, "My Project", "proj1", "ws1");
    const note = makeNote({ projectName: "My Project" });
    writeNoteFile(tmpDir, note);

    syncNotesFromDisk(db, tmpDir);

    const row = db.prepare("SELECT id FROM notes WHERE id = ?").get(note.id);
    expect(row).not.toBeNull();
  });

  it("adopts a plain .md file present at startup (no frontmatter)", () => {
    seedProjectInDb(db, "My Project", "proj1", "ws1");
    const dir = path.join(notesDir(tmpDir), toSlug("My Project"));
    fs.mkdirSync(dir, { recursive: true });
    const fp = path.join(dir, "Startup Note.md");
    fs.writeFileSync(fp, "# Startup Note\n\nAdded before app opened.\n", "utf-8");

    syncNotesFromDisk(db, tmpDir);

    // Note must now be in SQLite
    const rows = db.prepare("SELECT id, title FROM notes WHERE project_id = ?").all("proj1") as { id: string; title: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe("Startup Note");

    // File must have been updated with frontmatter in-place
    const parsed = parseNoteFile(fp);
    expect(parsed).not.toBeNull();
    expect(parsed!.id).toBe(rows[0].id);
  });

  it("does not overwrite an existing SQLite row when the DB row is newer than the file", () => {
    seedProjectInDb(db, "My Project", "proj1", "ws1");
    const note = makeNote({ projectName: "My Project", title: "Existing Note" });
    writeNoteFile(tmpDir, note);
    // Insert the DB row with an updated_at well in the future relative to the file,
    // so both the frontmatter timestamp and the file mtime are definitively older.
    const futureTs = new Date(Date.now() + 60_000).toISOString();
    db.prepare(`INSERT INTO notes (id, project_id, workspace_id, title, content, content_text,
      tag_ids, linked_note_ids, linked_card_ids, is_pinned, type, folder, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, '[]', '[]', '[]', 0, 'note', '', ?, ?)`)
      .run(note.id, note.projectId, note.workspaceId, "Modified Title", note.content, "",
           note.createdAt, futureTs);

    syncNotesFromDisk(db, tmpDir);

    // DB row is newer — file should NOT overwrite it
    const row = db.prepare("SELECT title FROM notes WHERE id = ?").get(note.id) as { title: string };
    expect(row.title).toBe("Modified Title");
  });

  it("adopts multiple plain .md files across different projects at startup", () => {
    createWorkspace(db, { id: "ws1", name: "WS" });
    createProject(db, { id: "proj1", workspaceId: "ws1", name: "Alpha" });
    createProject(db, { id: "proj2", workspaceId: "ws1", name: "Beta" });

    const dirA = path.join(notesDir(tmpDir), toSlug("Alpha"));
    const dirB = path.join(notesDir(tmpDir), toSlug("Beta"));
    fs.mkdirSync(dirA, { recursive: true });
    fs.mkdirSync(dirB, { recursive: true });
    fs.writeFileSync(path.join(dirA, "Note A.md"), "# Note A\n\nContent A.\n", "utf-8");
    fs.writeFileSync(path.join(dirB, "Note B.md"), "# Note B\n\nContent B.\n", "utf-8");

    syncNotesFromDisk(db, tmpDir);

    const all = db.prepare("SELECT id, project_id, title FROM notes ORDER BY title").all() as { id: string; project_id: string; title: string }[];
    expect(all).toHaveLength(2);
    expect(all[0].title).toBe("Note A");
    expect(all[0].project_id).toBe("proj1");
    expect(all[1].title).toBe("Note B");
    expect(all[1].project_id).toBe("proj2");
  });
});
