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
import {
  toSlug,
  writeNoteFile,
  parseNoteFile,
  resolveNoteFilePath,
  deleteNoteFile,
  stripMarkdown,
  projectNotesDir,
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
