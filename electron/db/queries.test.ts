/**
 * Unit tests for electron/db/queries.ts
 *
 * Uses an in-memory SQLite database for each test group. The system Node
 * binding for better-sqlite3 is loaded directly via require() — no Electron
 * ABI is required because vitest runs in plain Node.
 */

import { describe, it, expect, beforeEach } from "vitest";
import BetterSqlite3 from "better-sqlite3";
import type Database from "better-sqlite3";
import { applySchema } from "./schema";
import {
  createWorkspace,
  createProject,
  createNote,
  updateNote,
  createColumn,
  createCard,
  updateCard,
  getCards,
  searchNotes,
  searchTasks,
  getFullSnapshot,
} from "./queries";

// ── Shared fixture builders ───────────────────────────────────────────────

function makeDb(): Database.Database {
  const db = new BetterSqlite3(":memory:");
  applySchema(db);
  return db;
}

function seedWorkspace(db: Database.Database, id = "ws1") {
  return createWorkspace(db, { id, name: "Test Workspace" });
}

function seedProject(db: Database.Database, workspaceId = "ws1", id = "proj1") {
  return createProject(db, { id, workspaceId, name: "Test Project" });
}

function seedColumn(
  db: Database.Database,
  projectId = "proj1",
  workspaceId = "ws1",
  id = "col1"
) {
  return createColumn(db, { id, projectId, workspaceId, name: "Backlog", type: "backlog", order: 0 });
}

// ── Notes CRUD ────────────────────────────────────────────────────────────

describe("createNote", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeDb();
    seedWorkspace(db);
    seedProject(db);
  });

  it("creates a note and returns correct fields", () => {
    const note = createNote(db, {
      id: "note1",
      projectId: "proj1",
      workspaceId: "ws1",
      title: "My Note",
      content: "Hello world",
    });

    expect(note.id).toBe("note1");
    expect(note.projectId).toBe("proj1");
    expect(note.workspaceId).toBe("ws1");
    expect(note.title).toBe("My Note");
    expect(note.content).toBe("Hello world");
    expect(note.type).toBe("note");
    expect(note.isPinned).toBe(false);
    expect(note.tagIds).toEqual([]);
    expect(note.linkedNoteIds).toEqual([]);
    expect(note.linkedCardIds).toEqual([]);
    expect(typeof note.createdAt).toBe("string");
    expect(typeof note.updatedAt).toBe("string");
    // SQLite returns NULL as null; the mapper types it as string|undefined but
    // the runtime value is null for unset optional columns
    expect(note.archivedAt == null).toBe(true);
  });

  it("persists type='dashboard' when specified", () => {
    const note = createNote(db, {
      id: "dash1",
      projectId: "proj1",
      workspaceId: "ws1",
      title: "Dashboard",
      type: "dashboard",
    });

    expect(note.type).toBe("dashboard");
  });

  it("defaults content to empty string when omitted", () => {
    const note = createNote(db, {
      id: "note2",
      projectId: "proj1",
      workspaceId: "ws1",
      title: "Empty Note",
    });

    expect(note.content).toBe("");
  });
});

describe("updateNote", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeDb();
    seedWorkspace(db);
    seedProject(db);
    createNote(db, {
      id: "note1",
      projectId: "proj1",
      workspaceId: "ws1",
      title: "Original Title",
      content: "Original content",
    });
  });

  it("updates title and content", () => {
    const updated = updateNote(db, "note1", {
      title: "New Title",
      content: "New content",
    });

    expect(updated.title).toBe("New Title");
    expect(updated.content).toBe("New content");
  });

  it("updatedAt changes after update", async () => {
    const before = createNote(db, {
      id: "note-ts",
      projectId: "proj1",
      workspaceId: "ws1",
      title: "Timestamp Test",
    });

    // Small delay to ensure timestamp difference
    await new Promise((r) => setTimeout(r, 5));

    const after = updateNote(db, "note-ts", { title: "Updated" });
    expect(after.updatedAt >= before.updatedAt).toBe(true);
  });

  it("soft-delete via archivedAt persists the value", () => {
    const archived = updateNote(db, "note1", {
      archivedAt: "2025-01-01T00:00:00.000Z",
    });

    expect(archived.archivedAt).toBe("2025-01-01T00:00:00.000Z");
  });

  it("archived notes are excluded from searchNotes results", () => {
    updateNote(db, "note1", { archivedAt: "2025-01-01T00:00:00.000Z" });

    const results = searchNotes(db, { query: "Original Title" });
    expect(results.find((n) => n.id === "note1")).toBeUndefined();
  });
});

// ── Cards CRUD ────────────────────────────────────────────────────────────

describe("createCard", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeDb();
    seedWorkspace(db);
    seedProject(db);
    seedColumn(db);
  });

  it("creates a card in the correct column", () => {
    const card = createCard(db, {
      id: "card1",
      columnId: "col1",
      projectId: "proj1",
      workspaceId: "ws1",
      title: "Fix bug",
    });

    expect(card.id).toBe("card1");
    expect(card.columnId).toBe("col1");
    expect(card.projectId).toBe("proj1");
    expect(card.title).toBe("Fix bug");
    expect(card.priority).toBe("medium");
    expect(card.tagIds).toEqual([]);
    expect(card.linkedNoteIds).toEqual([]);
    expect(typeof card.createdAt).toBe("string");
  });

  it("persists custom priority", () => {
    const card = createCard(db, {
      id: "card2",
      columnId: "col1",
      projectId: "proj1",
      workspaceId: "ws1",
      title: "Urgent task",
      priority: "urgent",
    });

    expect(card.priority).toBe("urgent");
  });
});

describe("updateCard", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeDb();
    seedWorkspace(db);
    seedProject(db);
    seedColumn(db);
    createCard(db, {
      id: "card1",
      columnId: "col1",
      projectId: "proj1",
      workspaceId: "ws1",
      title: "Original",
      priority: "low",
    });
  });

  it("updates priority and title", () => {
    const updated = updateCard(db, "card1", {
      title: "Updated Task",
      priority: "high",
    });

    expect(updated.title).toBe("Updated Task");
    expect(updated.priority).toBe("high");
  });
});

describe("card ordering", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeDb();
    seedWorkspace(db);
    seedProject(db);
    seedColumn(db);
  });

  it("multiple cards in the same column have sequential order values", () => {
    createCard(db, { id: "c1", columnId: "col1", projectId: "proj1", workspaceId: "ws1", title: "First", order: 0 });
    createCard(db, { id: "c2", columnId: "col1", projectId: "proj1", workspaceId: "ws1", title: "Second", order: 1 });
    createCard(db, { id: "c3", columnId: "col1", projectId: "proj1", workspaceId: "ws1", title: "Third", order: 2 });

    const cards = getCards(db, { columnId: "col1" });
    expect(cards.map((c) => c.order)).toEqual([0, 1, 2]);
    expect(cards.map((c) => c.id)).toEqual(["c1", "c2", "c3"]);
  });
});

// ── Projects and Columns ──────────────────────────────────────────────────

describe("createProject", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeDb();
    seedWorkspace(db);
  });

  it("persists project with correct fields", () => {
    const project = createProject(db, {
      id: "proj1",
      workspaceId: "ws1",
      name: "My Project",
      description: "A test project",
      status: "active",
      priority: "high",
    });

    expect(project.id).toBe("proj1");
    expect(project.workspaceId).toBe("ws1");
    expect(project.name).toBe("My Project");
    expect(project.description).toBe("A test project");
    expect(project.status).toBe("active");
    expect(project.priority).toBe("high");
    expect(project.tagIds).toEqual([]);
    expect(typeof project.createdAt).toBe("string");
  });

  it("defaults status to 'active' and priority to 'medium'", () => {
    const project = createProject(db, {
      id: "proj2",
      workspaceId: "ws1",
      name: "Minimal Project",
    });

    expect(project.status).toBe("active");
    expect(project.priority).toBe("medium");
  });
});

describe("createColumn", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeDb();
    seedWorkspace(db);
    seedProject(db);
  });

  it("persists column with correct projectId and fields", () => {
    const col = createColumn(db, {
      id: "col1",
      projectId: "proj1",
      workspaceId: "ws1",
      name: "In Progress",
      type: "in_progress",
      order: 2,
    });

    expect(col.id).toBe("col1");
    expect(col.projectId).toBe("proj1");
    expect(col.workspaceId).toBe("ws1");
    expect(col.name).toBe("In Progress");
    expect(col.type).toBe("in_progress");
    expect(col.order).toBe(2);
  });
});

// ── Search ────────────────────────────────────────────────────────────────

describe("searchNotes", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeDb();
    seedWorkspace(db);
    seedProject(db);
    // Second project for cross-project filtering
    createProject(db, { id: "proj2", workspaceId: "ws1", name: "Other Project" });

    createNote(db, { id: "n1", projectId: "proj1", workspaceId: "ws1", title: "Alpha Note", content: "some content" });
    createNote(db, { id: "n2", projectId: "proj1", workspaceId: "ws1", title: "Beta Note", content: "other content" });
    createNote(db, { id: "n3", projectId: "proj2", workspaceId: "ws1", title: "Alpha in Other Project" });
  });

  it("finds notes by title substring (case-insensitive)", () => {
    const results = searchNotes(db, { query: "alpha" });
    const ids = results.map((n) => n.id);
    expect(ids).toContain("n1");
    expect(ids).toContain("n3");
    expect(ids).not.toContain("n2");
  });

  it("respects projectId filter", () => {
    const results = searchNotes(db, { query: "alpha", projectId: "proj1" });
    expect(results.map((n) => n.id)).toEqual(["n1"]);
  });

  it("returns empty array when no match", () => {
    const results = searchNotes(db, { query: "zzznomatch" });
    expect(results).toHaveLength(0);
  });
});

describe("searchTasks", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeDb();
    seedWorkspace(db);
    seedProject(db);
    seedColumn(db);

    createCard(db, { id: "c1", columnId: "col1", projectId: "proj1", workspaceId: "ws1", title: "Fix login bug" });
    createCard(db, { id: "c2", columnId: "col1", projectId: "proj1", workspaceId: "ws1", title: "Update readme" });
    createCard(db, { id: "c3", columnId: "col1", projectId: "proj1", workspaceId: "ws1", title: "Fix signup bug" });
  });

  it("finds tasks by title substring", () => {
    const results = searchTasks(db, { query: "fix" });
    const ids = results.map((c) => c.id);
    expect(ids).toContain("c1");
    expect(ids).toContain("c3");
    expect(ids).not.toContain("c2");
  });

  it("returns empty array when no match", () => {
    const results = searchTasks(db, { query: "zzznomatch" });
    expect(results).toHaveLength(0);
  });
});

// ── Full Snapshot ─────────────────────────────────────────────────────────

describe("getFullSnapshot", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeDb();
  });

  it("returns empty collections for a fresh DB", () => {
    const snap = getFullSnapshot(db);
    expect(snap.workspaces).toHaveLength(0);
    expect(snap.projects).toHaveLength(0);
    expect(snap.notes).toHaveLength(0);
    expect(snap.columns).toHaveLength(0);
    expect(snap.cards).toHaveLength(0);
    expect(snap.tags).toHaveLength(0);
  });

  it("includes all newly created entities", () => {
    seedWorkspace(db);
    seedProject(db);
    seedColumn(db);
    createNote(db, { id: "n1", projectId: "proj1", workspaceId: "ws1", title: "Note 1" });
    createCard(db, { id: "c1", columnId: "col1", projectId: "proj1", workspaceId: "ws1", title: "Card 1" });

    const snap = getFullSnapshot(db);
    expect(snap.workspaces.map((w) => w.id)).toContain("ws1");
    expect(snap.projects.map((p) => p.id)).toContain("proj1");
    expect(snap.notes.map((n) => n.id)).toContain("n1");
    expect(snap.columns.map((c) => c.id)).toContain("col1");
    expect(snap.cards.map((c) => c.id)).toContain("c1");
  });

  it("snapshot notes reflect getNotes results", () => {
    seedWorkspace(db);
    seedProject(db);
    createNote(db, { id: "n1", projectId: "proj1", workspaceId: "ws1", title: "Alpha" });
    createNote(db, { id: "n2", projectId: "proj1", workspaceId: "ws1", title: "Beta" });

    const snap = getFullSnapshot(db);
    expect(snap.notes).toHaveLength(2);
  });
});
