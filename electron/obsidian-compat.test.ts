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
import { createWorkspace, createProject, updateProject } from "./db/queries";
import {
  toSlug,
  writeNoteFile,
  parseNoteFile,
  notesDir,
  adoptExternalNoteFile,
  syncNotesFromDisk,
  importVaultProjects,
  previewVaultImport,
  saveImportExclusions,
  isImportPathExcluded,
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

  it("does not skip root notes/ folder in an Obsidian vault even if it has no direct .md files, scanning it as a project", () => {
    // Create the .obsidian folder to mark it as an Obsidian vault
    fs.mkdirSync(path.join(tmpDir, ".obsidian"), { recursive: true });

    // Seed project "notes" in the DB
    seedProject(db, "notes", "proj-notes", "ws1");

    // Create notes/ directory with a subdirectory, but no direct .md files at root of notes/
    const notesDir = path.join(tmpDir, "notes");
    const subProjDir = path.join(notesDir, "sub-folder");
    fs.mkdirSync(subProjDir, { recursive: true });
    writePlainMdFile(subProjDir, "Sub Note.md", "# Sub Note\n\nContent.");

    // Run sync
    syncNotesFromDisk(db, tmpDir);

    // Verify: The sub-note is imported successfully under the notes project, even though notes/ had no direct .md files!
    const rows = db.prepare("SELECT title, folder FROM notes WHERE project_id = ?").all("proj-notes") as { title: string; folder: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe("Sub Note");
    expect(rows[0].folder).toBe("sub-folder");
  });
});

// ── Test: auto-create projects from vault folders (no pre-existing project) ─
//
// Regression coverage for the reported bug: users point Cairn at an existing
// Obsidian vault (or copy a folder of notes into the workspace) and nothing
// shows up, because the old scan only imported notes into projects that
// already existed. Now the scan discovers top-level folders and loose root
// .md files and creates projects for them.

describe("importVaultProjects auto-creates projects from folders", () => {
  let db: Database.Database;

  /** Seed ONLY a workspace (no projects) — the exact failing scenario. */
  function seedWorkspaceOnly(wsId = "ws1") {
    createWorkspace(db, { id: wsId, name: "Test Workspace" });
    return wsId;
  }

  beforeEach(() => { db = makeDb(); });

  it("creates a project per top-level folder that has notes, then imports them", () => {
    seedWorkspaceOnly();

    // An Obsidian vault with top-level folders, no matching DB projects. One
    // folder has a space in its name ("My Journal") to exercise
    // adoptExternalNoteFile's slug-vs-raw-segment resolution, not just simple
    // single-word folder names.
    writePlainMdFile(path.join(tmpDir, "Journal"), "2025-01-01.md", "# Jan 1\n\nEntry.");
    writeObsidianFile(path.join(tmpDir, "Projects"), "Roadmap.md",
      { title: "Roadmap", tags: ["planning"] }, "\n# Roadmap\n\nBig plans.");
    writePlainMdFile(path.join(tmpDir, "My Journal"), "Entry.md", "# Entry\n\nWith a space.");

    syncNotesFromDisk(db, tmpDir);

    const projects = db.prepare("SELECT name FROM projects ORDER BY name").all() as { name: string }[];
    expect(projects.map((p) => p.name)).toEqual(["Journal", "My Journal", "Projects"]);

    // Notes imported under their auto-created projects.
    const journal = db.prepare(
      "SELECT n.title FROM notes n JOIN projects p ON n.project_id = p.id WHERE p.name = 'Journal'",
    ).all() as { title: string }[];
    expect(journal.map((r) => r.title)).toEqual(["2025-01-01"]);

    const proj = db.prepare(
      "SELECT n.title FROM notes n JOIN projects p ON n.project_id = p.id WHERE p.name = 'Projects'",
    ).all() as { title: string }[];
    expect(proj.map((r) => r.title)).toEqual(["Roadmap"]);

    // The spaced folder resolved correctly (raw segment "My Journal" ==
    // toSlug("My Journal")) and its note landed in the right project.
    const spaced = db.prepare(
      "SELECT n.title, n.folder FROM notes n JOIN projects p ON n.project_id = p.id WHERE p.name = 'My Journal'",
    ).all() as { title: string; folder: string }[];
    expect(spaced.map((r) => r.title)).toEqual(["Entry"]);
    expect(spaced[0].folder).toBe("");
  });

  it("creates default board columns for each auto-created project", () => {
    seedWorkspaceOnly();
    writePlainMdFile(path.join(tmpDir, "Journal"), "Note.md", "# Note\n\nBody.");

    syncNotesFromDisk(db, tmpDir);

    const proj = db.prepare("SELECT id FROM projects WHERE name = 'Journal'").get() as { id: string };
    const cols = db.prepare("SELECT type FROM board_columns WHERE project_id = ? ORDER BY \"order\"").all(proj.id) as { type: string }[];
    expect(cols.map((c) => c.type)).toEqual(["backlog", "todo", "in_progress", "review", "done"]);
  });

  it("imports loose root .md files into a catch-all project named after the vault folder", () => {
    seedWorkspaceOnly();

    // Loose files sitting directly in the vault root (not in any subfolder).
    writePlainMdFile(tmpDir, "Inbox Idea.md", "# Idea\n\nA loose thought.");
    writeObsidianFile(tmpDir, "Quick Note.md", { title: "Quick Note" }, "\n# Quick\n\nAnother.");

    syncNotesFromDisk(db, tmpDir);

    // Exactly one project, named after the vault folder.
    const projects = db.prepare("SELECT id, name FROM projects").all() as { id: string; name: string }[];
    expect(projects).toHaveLength(1);
    expect(projects[0].name).toBe(path.basename(tmpDir));

    const titles = db.prepare("SELECT title FROM notes WHERE project_id = ? ORDER BY title").all(projects[0].id) as { title: string }[];
    expect(titles.map((r) => r.title)).toEqual(["Inbox Idea", "Quick Note"]);
  });

  it("skips .obsidian, .git and infra folders when discovering projects", () => {
    seedWorkspaceOnly();

    fs.mkdirSync(path.join(tmpDir, ".obsidian"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, ".obsidian", "app.md"), "# nope\n", "utf-8");
    fs.mkdirSync(path.join(tmpDir, ".git"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, ".git", "x.md"), "# nope\n", "utf-8");
    writePlainMdFile(path.join(tmpDir, "assets"), "ignore.md", "# no\n");
    writePlainMdFile(path.join(tmpDir, "Real"), "Note.md", "# Real\n\nBody.");

    syncNotesFromDisk(db, tmpDir);

    const projects = db.prepare("SELECT name FROM projects").all() as { name: string }[];
    expect(projects.map((p) => p.name)).toEqual(["Real"]);
  });

  it("previews importable projects recursively without modifying vault files", () => {
    writePlainMdFile(path.join(tmpDir, "Research", "papers"), "Paper.md", "# Paper\n");
    writePlainMdFile(path.join(tmpDir, "templates"), "Meeting.md", "# Template\n");
    writePlainMdFile(path.join(tmpDir, "Research"), "Drawing.excalidraw.md", "scene data\n");
    writePlainMdFile(tmpDir, "Inbox.md", "# Inbox\n");
    const before = fs.readFileSync(path.join(tmpDir, "Research", "papers", "Paper.md"), "utf-8");

    const preview = previewVaultImport(tmpDir);

    expect(preview.noteCount).toBe(2);
    expect(preview.skippedCount).toBe(2);
    expect(preview.projects).toEqual([
      { name: path.basename(tmpDir), noteCount: 1, root: true, projectKey: toSlug(path.basename(tmpDir)) },
      { name: "Research", noteCount: 1, root: false, projectKey: toSlug("Research") },
    ]);
    expect(fs.readFileSync(path.join(tmpDir, "Research", "papers", "Paper.md"), "utf-8")).toBe(before);
  });

  it("uses project keys so preview counts match slug-collapsed imports", () => {
    const vaultName = path.basename(tmpDir);
    writePlainMdFile(tmpDir, "Root.md", "# Root\n");
    writePlainMdFile(path.join(tmpDir, vaultName), "Nested.md", "# Nested\n");

    const preview = previewVaultImport(tmpDir);

    expect(preview.projects).toHaveLength(2);
    expect(new Set(preview.projects.map((project) => project.projectKey)).size).toBe(1);
  });

  it("skips a non-Obsidian notes/ folder with only nested .md files in the preview", () => {
    // Regression: the preview must not promise a nonzero import for a `notes/`
    // tree the scan would skip (no direct .md files and not an Obsidian vault).
    writePlainMdFile(path.join(tmpDir, "notes", "sub"), "Deep.md", "# Deep\n");

    const preview = previewVaultImport(tmpDir);

    expect(preview.projects.some((project) => project.name === "notes")).toBe(false);
    expect(preview.noteCount).toBe(0);
  });

  it("skips templates and Excalidraw files without stamping frontmatter", () => {
    seedWorkspaceOnly();
    const template = writePlainMdFile(path.join(tmpDir, "templates"), "Meeting.md", "# Template\n");
    const drawing = writePlainMdFile(path.join(tmpDir, "Research"), "Drawing.excalidraw.md", "scene data\n");
    const real = writePlainMdFile(path.join(tmpDir, "Research"), "Paper.md", "# Paper\n");

    syncNotesFromDisk(db, tmpDir);

    expect((db.prepare("SELECT COUNT(*) n FROM notes").get() as { n: number }).n).toBe(1);
    expect(fs.readFileSync(template, "utf-8")).toBe("# Template\n");
    expect(fs.readFileSync(drawing, "utf-8")).toBe("scene data\n");
    expect(fs.readFileSync(real, "utf-8")).toContain("projectId:");
  });

  it("persists excluded top-level folders across later scans", () => {
    seedWorkspaceOnly();
    const privateNote = writePlainMdFile(path.join(tmpDir, "Private"), "Secret.md", "# Secret\n");
    writePlainMdFile(path.join(tmpDir, "Public"), "Shared.md", "# Shared\n");
    saveImportExclusions(tmpDir, ["Private"]);

    syncNotesFromDisk(db, tmpDir);
    syncNotesFromDisk(db, tmpDir);

    const projects = db.prepare("SELECT name FROM projects ORDER BY name").all() as Array<{ name: string }>;
    expect(projects.map((project) => project.name)).toEqual(["Public"]);
    expect(fs.readFileSync(privateNote, "utf-8")).toBe("# Secret\n");
    // Seed a live "Private" project so adoption can RESOLVE the file's owning
    // project — a null return then proves the exclusion gate, not missing-
    // project resolution.
    createProject(db, { id: "proj-private", workspaceId: "ws1", name: "Private" });
    expect(adoptExternalNoteFile(db, tmpDir, privateNote)).toBeNull();
  });

  it("falls back to the last valid exclusions when the config is corrupted mid-life", () => {
    // Regression for the review finding: a truncated / conflict-marked config
    // must never fail OPEN to importing folders the user excluded.
    seedWorkspaceOnly();
    const privateNote = writePlainMdFile(path.join(tmpDir, "Private"), "Secret.md", "# Secret\n");
    writePlainMdFile(path.join(tmpDir, "Public"), "Shared.md", "# Shared\n");
    saveImportExclusions(tmpDir, ["Private"]);
    syncNotesFromDisk(db, tmpDir); // first read caches the valid exclusions

    fs.writeFileSync(path.join(tmpDir, ".cairn-import.json"), "{ this is not json", "utf-8");

    syncNotesFromDisk(db, tmpDir);

    const projects = db.prepare("SELECT name FROM projects ORDER BY name").all() as Array<{ name: string }>;
    expect(projects.map((project) => project.name)).toEqual(["Public"]);
    // Seed a live "Private" project so adoption can RESOLVE the file's owning
    // project — a null return then proves the exclusion gate survived the
    // corrupted config, not missing-project resolution.
    createProject(db, { id: "proj-private", workspaceId: "ws1", name: "Private" });
    expect(adoptExternalNoteFile(db, tmpDir, privateNote)).toBeNull();
  });

  it("halts the scan when the config is malformed and never parsed successfully", () => {
    seedWorkspaceOnly();
    writePlainMdFile(path.join(tmpDir, "Private"), "Secret.md", "# Secret\n");
    fs.writeFileSync(path.join(tmpDir, ".cairn-import.json"), "{ this is not json", "utf-8");

    expect(importVaultProjects(db, tmpDir)).toBe(0);
    syncNotesFromDisk(db, tmpDir);

    const notes = db.prepare("SELECT COUNT(*) n FROM notes").get() as { n: number };
    expect(notes.n).toBe(0);
  });

  it("treats a non-string excludedFolders entry as invalid (halts a never-valid config)", () => {
    seedWorkspaceOnly();
    writePlainMdFile(path.join(tmpDir, "Private"), "Secret.md", "# Secret\n");
    // A single bad entry poisons the whole list — it must halt, not silently
    // drop the entry and import folders the user intended to keep out.
    fs.writeFileSync(path.join(tmpDir, ".cairn-import.json"), JSON.stringify({ excludedFolders: ["Private", 42] }), "utf-8");

    expect(importVaultProjects(db, tmpDir)).toBe(0);
    syncNotesFromDisk(db, tmpDir);

    const notes = db.prepare("SELECT COUNT(*) n FROM notes").get() as { n: number };
    expect(notes.n).toBe(0);
  });

  it("falls back to the last valid exclusions when a new entry is non-string", () => {
    seedWorkspaceOnly();
    const privateNote = writePlainMdFile(path.join(tmpDir, "Private"), "Secret.md", "# Secret\n");
    writePlainMdFile(path.join(tmpDir, "Public"), "Shared.md", "# Shared\n");
    saveImportExclusions(tmpDir, ["Private"]);
    syncNotesFromDisk(db, tmpDir); // caches the valid exclusions

    fs.writeFileSync(path.join(tmpDir, ".cairn-import.json"), JSON.stringify({ excludedFolders: ["Private", 42] }), "utf-8");

    syncNotesFromDisk(db, tmpDir);

    const projects = db.prepare("SELECT name FROM projects ORDER BY name").all() as Array<{ name: string }>;
    expect(projects.map((project) => project.name)).toEqual(["Public"]);
    expect(adoptExternalNoteFile(db, tmpDir, privateNote)).toBeNull();
  });

  it("halts freshly-malformed configs in isImportPathExcluded for root and nested paths", () => {
    seedWorkspaceOnly();
    const rootMd = writePlainMdFile(tmpDir, "Root.md", "# Root\n");
    const nestedMd = writePlainMdFile(path.join(tmpDir, "Folder"), "Note.md", "# Note\n");
    // Never valid — must halt on first encounter, even before a scan runs.
    fs.writeFileSync(path.join(tmpDir, ".cairn-import.json"), "{ this is not json", "utf-8");

    expect(isImportPathExcluded(tmpDir, rootMd)).toBe(true);
    expect(isImportPathExcluded(tmpDir, nestedMd)).toBe(true);
  });

  it("does not create a project for an empty top-level folder (no .md files)", () => {
    seedWorkspaceOnly();
    fs.mkdirSync(path.join(tmpDir, "Empty"), { recursive: true });
    writePlainMdFile(path.join(tmpDir, "HasNotes"), "Note.md", "# Note\n\nBody.");

    syncNotesFromDisk(db, tmpDir);

    const projects = db.prepare("SELECT name FROM projects").all() as { name: string }[];
    expect(projects.map((p) => p.name)).toEqual(["HasNotes"]);
  });

  it("discovers notes in nested subfolders and preserves the folder path", () => {
    seedWorkspaceOnly();
    writePlainMdFile(path.join(tmpDir, "Research", "papers", "2024"), "Deep.md", "# Deep\n\nNested.");

    syncNotesFromDisk(db, tmpDir);

    const row = db.prepare(
      "SELECT n.title, n.folder FROM notes n JOIN projects p ON n.project_id = p.id WHERE p.name = 'Research'",
    ).get() as { title: string; folder: string } | undefined;
    expect(row?.title).toBe("Deep");
    expect(row?.folder).toBe(path.join("papers", "2024"));
  });

  it("is idempotent — a second scan creates no duplicate projects or notes", () => {
    seedWorkspaceOnly();
    writePlainMdFile(path.join(tmpDir, "Journal"), "Note.md", "# Note\n\nBody.");

    syncNotesFromDisk(db, tmpDir);
    syncNotesFromDisk(db, tmpDir);

    const projects = db.prepare("SELECT name FROM projects").all() as { name: string }[];
    expect(projects).toHaveLength(1);
    const notes = db.prepare("SELECT id FROM notes").all();
    expect(notes).toHaveLength(1);
  });

  it("does nothing (no crash) when there is no workspace yet — onboarding first scan", () => {
    // No workspace seeded — mirrors reinitialise() running before createWorkspace.
    writePlainMdFile(path.join(tmpDir, "Journal"), "Note.md", "# Note\n\nBody.");

    const created = importVaultProjects(db, tmpDir);
    expect(created).toBe(0);
    const projects = db.prepare("SELECT name FROM projects").all();
    expect(projects).toHaveLength(0);

    // But once a workspace exists, a rescan picks everything up.
    createWorkspace(db, { id: "ws1", name: "Test Workspace" });
    syncNotesFromDisk(db, tmpDir);
    const after = db.prepare("SELECT name FROM projects").all() as { name: string }[];
    expect(after.map((p) => p.name)).toEqual(["Journal"]);
  });

  it("leaves existing projects alone and only creates the missing ones", () => {
    createWorkspace(db, { id: "ws1", name: "Test Workspace" });
    createProject(db, { id: "proj-existing", workspaceId: "ws1", name: "Journal" });

    writePlainMdFile(path.join(tmpDir, "Journal"), "Old.md", "# Old\n\nBody.");
    writePlainMdFile(path.join(tmpDir, "NewFolder"), "New.md", "# New\n\nBody.");

    const created = importVaultProjects(db, tmpDir);
    expect(created).toBe(1); // only NewFolder

    const projects = db.prepare("SELECT name FROM projects ORDER BY name").all() as { name: string }[];
    expect(projects.map((p) => p.name)).toEqual(["Journal", "NewFolder"]);
  });

  it("creates a project for a folder whose slug matches an ARCHIVED project, and imports its notes", () => {
    // Regression for the review finding: importVaultProjects and
    // adoptExternalNoteFile must agree on which projects "exist". Both consider
    // only LIVE projects, so an archived project's slug never shadows a folder.
    createWorkspace(db, { id: "ws1", name: "Test Workspace" });
    const archived = createProject(db, { id: "proj-arch", workspaceId: "ws1", name: "Journal" });
    updateProject(db, archived.id, { archivedAt: "2025-01-01T00:00:00.000Z" });

    writePlainMdFile(path.join(tmpDir, "Journal"), "Entry.md", "# Entry\n\nBody.");

    syncNotesFromDisk(db, tmpDir);

    // A NEW live project must be created for the folder…
    const live = db.prepare(
      "SELECT id, name FROM projects WHERE archived_at IS NULL AND name = 'Journal'",
    ).all() as { id: string; name: string }[];
    expect(live).toHaveLength(1);
    expect(live[0].id).not.toBe("proj-arch");

    // …and the note must be imported under it (not black-holed).
    const notes = db.prepare("SELECT title FROM notes WHERE project_id = ?").all(live[0].id) as { title: string }[];
    expect(notes.map((n) => n.title)).toEqual(["Entry"]);
  });

  it("attaches discovered projects to the supplied workspace, not just the oldest", () => {
    // Multi-workspace: importVaultProjects must honour an explicit workspaceId.
    createWorkspace(db, { id: "ws-old", name: "Older" });
    createWorkspace(db, { id: "ws-new", name: "Newer" });

    writePlainMdFile(path.join(tmpDir, "Journal"), "Note.md", "# Note\n\nBody.");

    const created = importVaultProjects(db, tmpDir, "ws-new");
    expect(created).toBe(1);

    const proj = db.prepare("SELECT workspace_id FROM projects WHERE name = 'Journal'").get() as { workspace_id: string };
    expect(proj.workspace_id).toBe("ws-new");
  });

  it("falls back to the oldest workspace when the supplied id doesn't exist", () => {
    createWorkspace(db, { id: "ws-old", name: "Older" });
    writePlainMdFile(path.join(tmpDir, "Journal"), "Note.md", "# Note\n\nBody.");

    const created = importVaultProjects(db, tmpDir, "does-not-exist");
    expect(created).toBe(1);
    const proj = db.prepare("SELECT workspace_id FROM projects WHERE name = 'Journal'").get() as { workspace_id: string };
    expect(proj.workspace_id).toBe("ws-old");
  });

  it("auto-created projects get a complete set of default columns (transactional)", () => {
    createWorkspace(db, { id: "ws1", name: "Test Workspace" });
    writePlainMdFile(path.join(tmpDir, "Journal"), "Note.md", "# Note\n\nBody.");

    syncNotesFromDisk(db, tmpDir);

    const proj = db.prepare("SELECT id FROM projects WHERE name = 'Journal'").get() as { id: string };
    const count = db.prepare("SELECT COUNT(*) AS n FROM board_columns WHERE project_id = ?").get(proj.id) as { n: number };
    expect(count.n).toBe(5);
  });
});

// ── Test: filename stability protects Obsidian wikilinks ──────────────────
//
// Obsidian resolves [[wikilinks]] by filename. Cairn must NOT rename a note's
// .md file just because its title differs from the filename (or a content/tag
// edit happened) — only an explicit rename (renameFile:true) may do so.

describe("filename stability (Obsidian wikilink safety)", () => {
  let db: Database.Database;
  beforeEach(() => { db = makeDb(); });

  /** List the .md filenames inside a project folder. */
  function mdFilesIn(projectName: string): string[] {
    const dir = path.join(notesDir(tmpDir), toSlug(projectName));
    return fs.readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
  }

  it("keeps the original filename when an adopted note's title differs from its filename", () => {
    seedProject(db, "ArchWiz");
    const projectDir = path.join(notesDir(tmpDir), toSlug("ArchWiz"));

    // Vault file "EP.md" whose frontmatter title is "Electron Process".
    const fp = writeObsidianFile(projectDir, "EP.md", {
      title: "Electron Process",
    }, "\n# Electron Process\n\nOriginal.");

    const adopted = adoptExternalNoteFile(db, tmpDir, fp);
    expect(adopted).not.toBeNull();

    // Simulate a Cairn CONTENT edit (no rename intent).
    writeNoteFile(tmpDir, {
      ...adopted!,
      content: "# Electron Process\n\nEdited in Cairn.",
      projectName: "ArchWiz",
    });

    // The file must STILL be EP.md — not renamed to electron-process.md — so
    // any [[EP]] wikilink elsewhere keeps resolving.
    expect(mdFilesIn("ArchWiz")).toEqual(["EP.md"]);
    expect(fs.existsSync(fp)).toBe(true);
  });

  it("keeps the filename on a metadata-only change (pin/tags)", () => {
    seedProject(db, "ArchWiz");
    const projectDir = path.join(notesDir(tmpDir), toSlug("ArchWiz"));
    const fp = writeObsidianFile(projectDir, "Notes On Kernels.md", {
      title: "A Completely Different Title",
    }, "\n# Kernels\n\nBody.");

    const adopted = adoptExternalNoteFile(db, tmpDir, fp);
    writeNoteFile(tmpDir, { ...adopted!, isPinned: true, projectName: "ArchWiz" });

    expect(mdFilesIn("ArchWiz")).toEqual(["Notes On Kernels.md"]);
  });

  it("DOES rename the file when renameFile is explicitly set (rename_note path)", () => {
    seedProject(db, "ArchWiz");
    const projectDir = path.join(notesDir(tmpDir), toSlug("ArchWiz"));
    const fp = writeObsidianFile(projectDir, "Old Name.md", {
      title: "Old Name",
    }, "\n# Old\n\nBody.");
    const adopted = adoptExternalNoteFile(db, tmpDir, fp);

    // Explicit rename — filename should follow the new title.
    writeNoteFile(tmpDir, {
      ...adopted!,
      title: "Brand New Name",
      projectName: "ArchWiz",
      renameFile: true,
    });

    expect(mdFilesIn("ArchWiz")).toEqual(["Brand New Name.md"]);
    expect(fs.existsSync(fp)).toBe(false); // old file gone
  });

  it("relocates the file on a folder change even without renameFile", () => {
    seedProject(db, "ArchWiz");
    const projectDir = path.join(notesDir(tmpDir), toSlug("ArchWiz"));
    const fp = writeObsidianFile(projectDir, "Movable.md", { title: "Movable" }, "\n# M\n\nBody.");
    const adopted = adoptExternalNoteFile(db, tmpDir, fp);

    // Folder change (root → "sub") must move the file, keeping its filename.
    writeNoteFile(tmpDir, { ...adopted!, folder: "sub", projectName: "ArchWiz" });

    expect(fs.existsSync(fp)).toBe(false); // old root path gone
    const moved = path.join(projectDir, "sub", "Movable.md");
    expect(fs.existsSync(moved)).toBe(true);
  });

  it("preserves the on-disk filename on a folder move when title ≠ filename", () => {
    // Regression: a folder-only move must NOT re-derive the filename from the
    // title. An adopted note "EP.md" whose title is "Electron Process" must move
    // as EP.md, not electron-process.md — otherwise [[EP]] wikilinks break.
    seedProject(db, "ArchWiz");
    const projectDir = path.join(notesDir(tmpDir), toSlug("ArchWiz"));
    const fp = writeObsidianFile(projectDir, "EP.md", { title: "Electron Process" }, "\n# EP\n\nBody.");
    const adopted = adoptExternalNoteFile(db, tmpDir, fp);
    expect(adopted!.title).toBe("Electron Process");

    // Move to subfolder "kernel" with renameFile OFF (a plain move).
    writeNoteFile(tmpDir, { ...adopted!, folder: "kernel", projectName: "ArchWiz" });

    expect(fs.existsSync(fp)).toBe(false);                       // old path gone
    const moved = path.join(projectDir, "kernel", "EP.md");      // filename preserved
    expect(fs.existsSync(moved)).toBe(true);
    expect(fs.existsSync(path.join(projectDir, "kernel", "electron-process.md"))).toBe(false);
  });
});
