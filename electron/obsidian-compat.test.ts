/**
 * Obsidian Vault Compatibility — Unit Tests
 *
 * Tests that Cairn can read, adopt, and write Obsidian-style .md files
 * without destroying non-Cairn frontmatter fields (tags, aliases, cssclass,
 * date, publish, etc.).
 *
 * Written TDD-style — these tests define the contract BEFORE the
 * implementation is updated.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import matter from "gray-matter";
import BetterSqlite3 from "better-sqlite3";
import type Database from "better-sqlite3";
import { applySchema } from "./db/schema";
import { createWorkspace, createProject } from "./db/queries";
import {
  toSlug,
  writeNoteFile,
  parseNoteFile,
  notesDir,
  adoptExternalNoteFile,
  syncNotesFromDisk,
} from "./notes-files";
import type { NoteData } from "./notes-files";

// ── Helpers ───────────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-obsidian-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeDb(): Database.Database {
  const db = new BetterSqlite3(":memory:");
  applySchema(db);
  return db;
}

function seedProject(db: Database.Database, name = "ArchWiz", id = "proj1", wsId = "ws1") {
  createWorkspace(db, { id: wsId, name: "Test Workspace" });
  return createProject(db, { id, workspaceId: wsId, name });
}

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
    projectName: "ArchWiz",
    ...overrides,
  };
}

/** Write an Obsidian-style .md file into a directory */
function writeObsidianFile(
  dir: string,
  filename: string,
  frontmatterData: Record<string, unknown>,
  body: string,
): string {
  fs.mkdirSync(dir, { recursive: true });
  const fp = path.join(dir, filename);
  fs.writeFileSync(fp, matter.stringify(body, frontmatterData), "utf-8");
  return fp;
}

/** Write a plain .md file (no frontmatter) */
function writePlainMdFile(dir: string, filename: string, body: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const fp = path.join(dir, filename);
  fs.writeFileSync(fp, body, "utf-8");
  return fp;
}

// ── Test: Frontmatter Preservation on writeNoteFile ──────────────────────

describe("writeNoteFile preserves non-Cairn frontmatter", () => {
  it("preserves Obsidian tags, aliases, and cssclass on re-write", () => {
    const projectDir = path.join(notesDir(tmpDir), toSlug("ArchWiz"));

    // Step 1: Write an Obsidian-style file with extra fields
    const obsidianFm = {
      title: "My Note",
      tags: ["archwiz", "architecture"],
      aliases: ["ArchNote", "Architecture"],
      cssclass: "custom-note",
    };
    const fp = writeObsidianFile(projectDir, "My Note.md", obsidianFm, "\n# My Note\n\nOriginal content.");

    // Step 2: Adopt it into Cairn
    const db = makeDb();
    seedProject(db, "ArchWiz");
    const adopted = adoptExternalNoteFile(db, tmpDir, fp);
    expect(adopted).not.toBeNull();

    // Step 3: Write it back via Cairn's writeNoteFile (simulating a Cairn edit)
    writeNoteFile(tmpDir, {
      ...adopted!,
      content: "# My Note\n\nEdited in Cairn.",
      projectName: "ArchWiz",
    });

    // Step 4: Read the file back and check that Obsidian fields survive
    const raw = fs.readFileSync(fp, "utf-8");
    const { data } = matter(raw);

    // Cairn fields present
    expect(data.id).toBe(adopted!.id);
    expect(data.projectId).toBe("proj1");

    // Obsidian fields preserved
    expect(data.tags).toEqual(["archwiz", "architecture"]);
    expect(data.aliases).toEqual(["ArchNote", "Architecture"]);
    expect(data.cssclass).toBe("custom-note");
  });

  it("preserves Obsidian date and publish fields", () => {
    const projectDir = path.join(notesDir(tmpDir), toSlug("ArchWiz"));

    const obsidianFm = {
      title: "Daily Note",
      date: "2025-01-15",
      tags: ["daily"],
      cssclass: "daily-note",
      publish: true,
    };
    const fp = writeObsidianFile(projectDir, "Daily Note.md", obsidianFm, "\n# Daily Note\n\nContent.");

    const db = makeDb();
    seedProject(db, "ArchWiz");
    const adopted = adoptExternalNoteFile(db, tmpDir, fp);
    expect(adopted).not.toBeNull();

    writeNoteFile(tmpDir, {
      ...adopted!,
      content: "# Daily Note\n\nUpdated content.",
      projectName: "ArchWiz",
    });

    const { data } = matter(fs.readFileSync(fp, "utf-8"));
    expect(data.date).toBe("2025-01-15");
    expect(data.publish).toBe(true);
    expect(data.cssclass).toBe("daily-note");
  });

  it("preserves custom/arbitrary frontmatter keys", () => {
    const projectDir = path.join(notesDir(tmpDir), toSlug("ArchWiz"));

    const obsidianFm = {
      title: "Custom Props",
      myCustomField: "hello world",
      nested: { key: "value", list: [1, 2, 3] },
      status: "in-progress",
    };
    const fp = writeObsidianFile(projectDir, "Custom Props.md", obsidianFm, "\n# Custom\n\nBody.");

    const db = makeDb();
    seedProject(db, "ArchWiz");
    const adopted = adoptExternalNoteFile(db, tmpDir, fp);

    writeNoteFile(tmpDir, { ...adopted!, projectName: "ArchWiz" });

    const { data } = matter(fs.readFileSync(fp, "utf-8"));
    expect(data.myCustomField).toBe("hello world");
    expect(data.nested).toEqual({ key: "value", list: [1, 2, 3] });
    expect(data.status).toBe("in-progress");
  });
});

// ── Test: adoptExternalNoteFile preserves Obsidian YAML ──────────────────

describe("adoptExternalNoteFile preserves Obsidian YAML", () => {
  let db: Database.Database;

  beforeEach(() => { db = makeDb(); });

  it("adds Cairn fields without removing Obsidian fields", () => {
    seedProject(db, "ArchWiz");
    const projectDir = path.join(notesDir(tmpDir), toSlug("ArchWiz"));

    const fp = writeObsidianFile(projectDir, "Overview.md", {
      title: "ArchWiz Architecture Overview",
      tags: ["archwiz", "architecture"],
    }, "\n# ArchWiz — Architecture Overview\n\nContent.");

    const note = adoptExternalNoteFile(db, tmpDir, fp);
    expect(note).not.toBeNull();
    expect(note!.title).toBe("ArchWiz Architecture Overview");

    // Re-read file — both Cairn and Obsidian fields must be present
    const { data } = matter(fs.readFileSync(fp, "utf-8"));
    expect(data.id).toBe(note!.id);
    expect(data.projectId).toBe("proj1");
    expect(data.tags).toEqual(["archwiz", "architecture"]);
  });

  it("uses Obsidian title frontmatter over filename when present", () => {
    seedProject(db, "ArchWiz");
    const projectDir = path.join(notesDir(tmpDir), toSlug("ArchWiz"));

    // Filename is "EP.md" but frontmatter title is "Electron Process"
    const fp = writeObsidianFile(projectDir, "EP.md", {
      title: "Electron Process",
      tags: ["electron"],
    }, "\n# Electron Process\n\nContent.");

    const note = adoptExternalNoteFile(db, tmpDir, fp);
    expect(note).not.toBeNull();
    // Should use the frontmatter title, not the filename
    expect(note!.title).toBe("Electron Process");
  });

  it("falls back to filename when no frontmatter title exists", () => {
    seedProject(db, "ArchWiz");
    const projectDir = path.join(notesDir(tmpDir), toSlug("ArchWiz"));

    const fp = writeObsidianFile(projectDir, "My Cool Note.md", {
      tags: ["misc"],
    }, "\n# My Cool Note\n\nContent.");

    const note = adoptExternalNoteFile(db, tmpDir, fp);
    expect(note).not.toBeNull();
    expect(note!.title).toBe("My Cool Note");
  });

  it("preserves aliases array", () => {
    seedProject(db, "ArchWiz");
    const projectDir = path.join(notesDir(tmpDir), toSlug("ArchWiz"));

    const fp = writeObsidianFile(projectDir, "OOHButter.md", {
      title: "OOH Butter!",
      tags: ["oohbutter"],
      aliases: ["OohButter", "OOHButter"],
    }, "\n# OOH Butter!\n\nContent.");

    adoptExternalNoteFile(db, tmpDir, fp);

    const { data } = matter(fs.readFileSync(fp, "utf-8"));
    expect(data.aliases).toEqual(["OohButter", "OOHButter"]);
  });
});

// ── Test: Wikilinks preserved in content ─────────────────────────────────

describe("Obsidian wikilinks preserved in content", () => {
  it("preserves ![[image.png]] embeds through round-trip", () => {
    const content = "# Note\n\nHere is an image:\n\n![[screenshot.png]]\n\nAnd text after.";
    const note = makeNote({ content, title: "Wikilink Test" });
    writeNoteFile(tmpDir, note);

    const dir = path.join(notesDir(tmpDir), toSlug(note.projectName!));
    const fp = path.join(dir, `${toSlug(note.title)}.md`);
    const parsed = parseNoteFile(fp);

    expect(parsed).not.toBeNull();
    expect(parsed!.content).toContain("![[screenshot.png]]");
  });

  it("preserves [[Note Name]] links through round-trip", () => {
    const content = "# Links\n\n- [[ArchWiz/Overview|Back to Overview]]\n- [[OOHButter/OOHButter]]";
    const note = makeNote({ content, title: "Wikilink Links" });
    writeNoteFile(tmpDir, note);

    const dir = path.join(notesDir(tmpDir), toSlug(note.projectName!));
    const fp = path.join(dir, `${toSlug(note.title)}.md`);
    const parsed = parseNoteFile(fp);

    expect(parsed).not.toBeNull();
    expect(parsed!.content).toContain("[[ArchWiz/Overview|Back to Overview]]");
    expect(parsed!.content).toContain("[[OOHButter/OOHButter]]");
  });

  it("preserves Obsidian task checkboxes", () => {
    const content = "# Tasks\n\n- [x] Done task\n- [ ] Open task\n- [/] In progress";
    const note = makeNote({ content, title: "Checkbox Test" });
    writeNoteFile(tmpDir, note);

    const dir = path.join(notesDir(tmpDir), toSlug(note.projectName!));
    const fp = path.join(dir, `${toSlug(note.title)}.md`);
    const parsed = parseNoteFile(fp);

    expect(parsed!.content).toContain("- [x] Done task");
    expect(parsed!.content).toContain("- [ ] Open task");
  });
});

// ── Test: No duplication after multiple write cycles ─────────────────────

describe("no duplicate frontmatter keys after multiple cycles", () => {
  it("does not duplicate Obsidian fields after 3 write cycles", () => {
    const db = makeDb();
    seedProject(db, "ArchWiz");
    const projectDir = path.join(notesDir(tmpDir), toSlug("ArchWiz"));

    // Use filename that matches the title so adoption doesn't rename
    const fp = writeObsidianFile(projectDir, "Stable Note.md", {
      title: "Stable Note",
      tags: ["test"],
      aliases: ["stable"],
      cssclass: "custom",
    }, "\n# Stable\n\nOriginal.");

    // Cycle 1: adopt
    const adopted = adoptExternalNoteFile(db, tmpDir, fp);
    expect(adopted).not.toBeNull();

    // Cycle 2: write with edit (file stays at same path since title matches filename)
    writeNoteFile(tmpDir, { ...adopted!, content: "# Stable\n\nEdit 1.", projectName: "ArchWiz" });

    // Cycle 3: re-read and write again
    const parsed = parseNoteFile(fp);
    expect(parsed).not.toBeNull();
    writeNoteFile(tmpDir, { ...parsed!, content: "# Stable\n\nEdit 2.", projectName: "ArchWiz" });

    // Final check: Obsidian fields appear exactly once
    const raw = fs.readFileSync(fp, "utf-8");
    const { data } = matter(raw);
    expect(data.tags).toEqual(["test"]);
    expect(data.aliases).toEqual(["stable"]);
    expect(data.cssclass).toBe("custom");

    // Count occurrences of "tags:" in raw YAML — should be exactly 1
    const tagMatches = raw.match(/^tags:/gm);
    expect(tagMatches).toHaveLength(1);
  });
});

// ── Test: syncNotesFromDisk with Obsidian vault ──────────────────────────

describe("syncNotesFromDisk with vault-root scanning", () => {
  let db: Database.Database;

  beforeEach(() => { db = makeDb(); });

  it("skips .obsidian directory during sync", () => {
    seedProject(db, "ArchWiz");

    // Create .obsidian dir with a .md file inside (should be ignored)
    const obsidianDir = path.join(notesDir(tmpDir), toSlug("ArchWiz"), ".obsidian");
    fs.mkdirSync(obsidianDir, { recursive: true });
    fs.writeFileSync(
      path.join(obsidianDir, "workspace.md"),
      "---\ntitle: internal\n---\n# Should be ignored\n",
      "utf-8",
    );

    // Create a real note alongside it
    const projectDir = path.join(notesDir(tmpDir), toSlug("ArchWiz"));
    writePlainMdFile(projectDir, "Real Note.md", "# Real Note\n\nContent.");

    syncNotesFromDisk(db, tmpDir);

    // Only the real note should be imported, not the .obsidian one
    const rows = db.prepare("SELECT title FROM notes WHERE project_id = ?").all("proj1") as { title: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe("Real Note");
  });

  it("skips all dot-prefixed directories", () => {
    seedProject(db, "ArchWiz");
    const projectDir = path.join(notesDir(tmpDir), toSlug("ArchWiz"));

    // Create dot-prefixed dirs with .md files
    for (const dotDir of [".trash", ".hidden", ".git"]) {
      const dir = path.join(projectDir, dotDir);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "hidden.md"), "# Hidden\n\nContent.", "utf-8");
    }

    // Create a visible note
    writePlainMdFile(projectDir, "Visible.md", "# Visible\n\nContent.");

    syncNotesFromDisk(db, tmpDir);

    const rows = db.prepare("SELECT title FROM notes WHERE project_id = ?").all("proj1") as { title: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe("Visible");
  });

  it("imports Obsidian files with frontmatter and preserves their fields", () => {
    seedProject(db, "ArchWiz");
    const projectDir = path.join(notesDir(tmpDir), toSlug("ArchWiz"));

    const fp = writeObsidianFile(projectDir, "Overview.md", {
      title: "ArchWiz Overview",
      tags: ["archwiz"],
      aliases: ["overview"],
    }, "\n# Overview\n\nContent.");

    syncNotesFromDisk(db, tmpDir);

    // Note imported into SQLite
    const rows = db.prepare("SELECT id, title FROM notes WHERE project_id = ?").all("proj1") as { id: string; title: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe("ArchWiz Overview");

    // Obsidian fields preserved in file
    const { data } = matter(fs.readFileSync(fp, "utf-8"));
    expect(data.tags).toEqual(["archwiz"]);
    expect(data.aliases).toEqual(["overview"]);
    // Cairn fields added
    expect(data.id).toBe(rows[0].id);
  });
});

// ── Test: Tag synchronization ────────────────────────────────────────────

describe("Obsidian tag ↔ Cairn tag sync", () => {
  let db: Database.Database;

  beforeEach(() => { db = makeDb(); });

  it("creates Cairn tags from Obsidian tags on adoption", () => {
    seedProject(db, "ArchWiz");
    const projectDir = path.join(notesDir(tmpDir), toSlug("ArchWiz"));

    const fp = writeObsidianFile(projectDir, "Tagged.md", {
      title: "Tagged Note",
      tags: ["architecture", "electron"],
    }, "\n# Tagged\n\nContent.");

    const note = adoptExternalNoteFile(db, tmpDir, fp);
    expect(note).not.toBeNull();

    // The note's tagIds should reference real tags in the DB
    // (or at minimum, the tag names should be stored for later resolution)
    // Check that tags were created in the DB
    const tags = db.prepare("SELECT name FROM tags WHERE workspace_id = ?").all("ws1") as { name: string }[];
    const tagNames = tags.map((t) => t.name);
    expect(tagNames).toContain("architecture");
    expect(tagNames).toContain("electron");
  });
});

// ── Test: Mixed scenarios ────────────────────────────────────────────────

describe("mixed Cairn and Obsidian files", () => {
  let db: Database.Database;

  beforeEach(() => { db = makeDb(); });

  it("handles a directory with both Cairn and Obsidian files", () => {
    seedProject(db, "Mixed");
    const projectDir = path.join(notesDir(tmpDir), toSlug("Mixed"));
    fs.mkdirSync(projectDir, { recursive: true });

    // Cairn-style file (has id and projectId)
    const cairnFm = {
      id: "cairn-note-1",
      projectId: "proj1",
      workspaceId: "ws1",
      title: "Cairn Note",
      folder: "",
      tagIds: [],
      linkedNoteIds: [],
      linkedCardIds: [],
      isPinned: false,
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-02T00:00:00.000Z",
    };
    writeObsidianFile(projectDir, "Cairn Note.md", cairnFm, "\n# Cairn Note\n\nCairn content.");

    // Obsidian-style file (has tags but no Cairn IDs)
    writeObsidianFile(projectDir, "Obsidian Note.md", {
      title: "Obsidian Note",
      tags: ["misc"],
    }, "\n# Obsidian Note\n\nObsidian content.");

    // Plain file (no frontmatter at all)
    writePlainMdFile(projectDir, "Plain.md", "# Plain\n\nPlain content.");

    syncNotesFromDisk(db, tmpDir);

    const rows = db.prepare("SELECT title FROM notes WHERE project_id = ? ORDER BY title")
      .all("proj1") as { title: string }[];

    expect(rows.length).toBe(3);
    expect(rows.map((r) => r.title)).toEqual(
      expect.arrayContaining(["Cairn Note", "Obsidian Note", "Plain"]),
    );
  });

  it("Cairn-originated note survives Obsidian editing (extra fields added externally)", () => {
    seedProject(db, "ArchWiz");
    const projectDir = path.join(notesDir(tmpDir), toSlug("ArchWiz"));

    // Write a note through Cairn
    const note = makeNote({ id: "cairn-1", title: "Cairn First" });
    writeNoteFile(tmpDir, note);

    // Simulate user opening in Obsidian and adding tags/aliases to frontmatter
    const fp = path.join(projectDir, `${toSlug(note.title)}.md`);
    const raw = fs.readFileSync(fp, "utf-8");
    const { data, content } = matter(raw);
    data.tags = ["manually-added"];
    data.aliases = ["cf"];
    fs.writeFileSync(fp, matter.stringify(content, data), "utf-8");

    // Now Cairn writes back (e.g. user edits content in Cairn)
    const parsed = parseNoteFile(fp);
    expect(parsed).not.toBeNull();
    writeNoteFile(tmpDir, {
      ...parsed!,
      content: "# Cairn First\n\nEdited in Cairn after Obsidian touched it.",
      projectName: "ArchWiz",
    });

    // Verify: Obsidian fields that user added are still there
    const { data: finalData } = matter(fs.readFileSync(fp, "utf-8"));
    expect(finalData.tags).toEqual(["manually-added"]);
    expect(finalData.aliases).toEqual(["cf"]);
    expect(finalData.id).toBe("cairn-1");
  });

  it("does not skip root notes/ folder if it has direct .md files, synchronising it as a project called notes", () => {
    seedProject(db, "notes", "proj-notes", "ws1");

    const notesDir = path.join(tmpDir, "notes");
    writePlainMdFile(notesDir, "My Note.md", "# My Note\n\nContent.");

    syncNotesFromDisk(db, tmpDir);

    const rows = db.prepare("SELECT title FROM notes WHERE project_id = ?").all("proj-notes") as { title: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe("My Note");
  });
});
