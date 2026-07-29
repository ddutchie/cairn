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
import * as os from "os";
import * as path from "path";
import { applySchema } from "./schema";
import {
  createWorkspace,
  createProject,
  createNote,
  updateNote,
  deleteNote,
  getNotes,
  findTombstonedNotes,
  findNestedConflictCopies,
  getNoteById,
  getNoteByIdIncludingTombstoned,
  moveNoteToProject,
  rewriteInboundWikilinks,
  createColumn,
  createCard,
  updateCard,
  getCards,
  moveCardToProject,
  mergeProject,
  getProjectById,
  getColumns,
  getOrCreateFlow,
  createFlowNode,
  getFlowNodes,
  searchNotes,
  searchTasks,
  getFullSnapshot,
  saveMcpServer,
  getMcpServers,
  getMcpServerById,
  deleteMcpServer,
  saveCustomService,
  getCustomServices,
  deleteCustomService,
  getToolAttachments,
  setToolAttachment,
  clearToolAttachment,
  upsertCodebaseFile,
  insertCodebaseSymbol,
  insertCodebaseRelation,
  getCodebaseOverview,
  getCodebaseGraph,
  getCodebaseModuleGraph,
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

describe("moveNoteToProject", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeDb();
    seedWorkspace(db);
    seedProject(db);
    // A second project in a different workspace to move into.
    createWorkspace(db, { id: "ws2", name: "Other Workspace" });
    createProject(db, { id: "proj2", workspaceId: "ws2", name: "Other Project" });
    createNote(db, {
      id: "note1",
      projectId: "proj1",
      workspaceId: "ws1",
      title: "Movable Note",
      content: "content",
    });
  });

  it("persists the new project_id and workspace_id (regression: updateNote drops them)", () => {
    const moved = moveNoteToProject(db, "note1", "proj2");
    expect(moved.projectId).toBe("proj2");
    expect(moved.workspaceId).toBe("ws2");

    // Re-read from the DB — the move must be durable, not just on the return value.
    const reloaded = getNoteById(db, "note1");
    expect(reloaded?.projectId).toBe("proj2");
    expect(reloaded?.workspaceId).toBe("ws2");
  });

  it("resolves the destination workspace from the target project, not a caller arg", () => {
    // proj2 belongs to ws2 (see beforeEach) — the note's workspace must follow
    // the project regardless of what any caller might have wanted.
    const moved = moveNoteToProject(db, "note1", "proj2");
    expect(moved.workspaceId).toBe("ws2");
  });

  it("rejects a move to a non-existent project (note stays put)", () => {
    expect(() => moveNoteToProject(db, "note1", "nope")).toThrow();
    const reloaded = getNoteById(db, "note1");
    expect(reloaded?.projectId).toBe("proj1");
    expect(reloaded?.workspaceId).toBe("ws1");
  });

  it("does NOT re-surface under the old project after the move", () => {
    moveNoteToProject(db, "note1", "proj2");
    const inOldProject = searchNotes(db, { query: "Movable Note", projectId: "proj1" });
    expect(inOldProject.find((n) => n.id === "note1")).toBeUndefined();
    const inNewProject = searchNotes(db, { query: "Movable Note", projectId: "proj2" });
    expect(inNewProject.find((n) => n.id === "note1")).toBeDefined();
  });

  it("bumps version and updated_at", async () => {
    const before = getNoteById(db, "note1");
    // Small delay so the ISO timestamp is strictly later (same-ms writes would tie).
    await new Promise((r) => setTimeout(r, 5));
    const moved = moveNoteToProject(db, "note1", "proj2");
    expect(moved.version).toBeGreaterThan(before?.version ?? -1);
    expect(moved.updatedAt > (before?.updatedAt ?? "")).toBe(true);
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

describe("moveCardToProject", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeDb();
    createWorkspace(db, { id: "ws1", name: "WS One" });
    createWorkspace(db, { id: "ws2", name: "WS Two" });
    createProject(db, { id: "proj1", workspaceId: "ws1", name: "Source" });
    createColumn(db, { id: "col1", projectId: "proj1", workspaceId: "ws1", name: "Todo", type: "todo", order: 0 });
    createProject(db, { id: "proj2", workspaceId: "ws2", name: "Dest" });
    createColumn(db, { id: "col2", projectId: "proj2", workspaceId: "ws2", name: "Todo", type: "todo", order: 0 });
    createCard(db, { id: "c1", columnId: "col1", projectId: "proj1", workspaceId: "ws1", title: "Card", order: 0 });
  });

  it("repoints project_id AND workspace_id AND column_id (not just the column)", () => {
    const moved = moveCardToProject(db, "c1", "proj2", "col2", 0);
    expect(moved.projectId).toBe("proj2");
    expect(moved.workspaceId).toBe("ws2"); // resolved from the target project
    expect(moved.columnId).toBe("col2");

    // The card leaves the source project entirely and appears in the target.
    expect(getCards(db, { projectId: "proj1" })).toHaveLength(0);
    expect(getCards(db, { projectId: "proj2" }).map((c) => c.id)).toEqual(["c1"]);
  });

  it("rejects a missing target project or column, or a column in another project", () => {
    expect(() => moveCardToProject(db, "c1", "nope", "col2", 0)).toThrow(/Target project not found/);
    expect(() => moveCardToProject(db, "c1", "proj2", "nope", 0)).toThrow(/Target column not found/);
    // col1 belongs to proj1, not proj2 → mismatch is rejected so the card can't
    // land in a column outside its new project.
    expect(() => moveCardToProject(db, "c1", "proj2", "col1", 0)).toThrow(/does not belong to project/);
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

// ── External tools: MCP servers ──────────────────────────────────────────────

describe("MCP server queries", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeDb();
    seedWorkspace(db);
  });

  it("saves, lists, and round-trips headers + transport", () => {
    saveMcpServer(db, {
      id: "m1", workspaceId: "ws1", name: "CoinGecko",
      transport: "sse", baseUrl: "https://mcp.coingecko.com/sse",
      headers: { Authorization: "secret://m1/Authorization" },
      enabled: true, source: "manual",
    });
    const list = getMcpServers(db, "ws1");
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe("CoinGecko");
    expect(list[0].transport).toBe("sse");
    expect(list[0].headers).toEqual({ Authorization: "secret://m1/Authorization" });
    expect(list[0].enabled).toBe(true);
  });

  it("upserts on conflicting id", () => {
    saveMcpServer(db, { id: "m1", workspaceId: "ws1", name: "A", transport: "http", baseUrl: "https://a", enabled: true, source: "manual" });
    saveMcpServer(db, { id: "m1", workspaceId: "ws1", name: "B", transport: "http", baseUrl: "https://b", enabled: false, source: "manual" });
    expect(getMcpServers(db, "ws1")).toHaveLength(1);
    expect(getMcpServerById(db, "m1")?.name).toBe("B");
    expect(getMcpServerById(db, "m1")?.enabled).toBe(false);
  });

  it("scopes by workspace", () => {
    createWorkspace(db, { id: "ws2", name: "Other" });
    saveMcpServer(db, { id: "m1", workspaceId: "ws1", name: "A", transport: "http", baseUrl: "https://a", enabled: true, source: "manual" });
    saveMcpServer(db, { id: "m2", workspaceId: "ws2", name: "B", transport: "http", baseUrl: "https://b", enabled: true, source: "manual" });
    expect(getMcpServers(db, "ws1")).toHaveLength(1);
    expect(getMcpServers(db, "ws2")).toHaveLength(1);
  });

  it("delete also removes attachments", () => {
    saveMcpServer(db, { id: "m1", workspaceId: "ws1", name: "A", transport: "http", baseUrl: "https://a", enabled: true, source: "manual" });
    setToolAttachment(db, { projectId: "p1", toolType: "mcp", toolId: "m1", enabled: true });
    deleteMcpServer(db, "m1");
    expect(getMcpServers(db, "ws1")).toHaveLength(0);
    expect(getToolAttachments(db, "p1")).toHaveLength(0);
  });

  it("defaults authMode to 'none' and round-trips oauth fields", () => {
    saveMcpServer(db, { id: "m1", workspaceId: "ws1", name: "Plain", transport: "http", baseUrl: "https://a", enabled: true, source: "manual" });
    expect(getMcpServerById(db, "m1")?.authMode).toBe("none");
    expect(getMcpServerById(db, "m1")?.oauthScope).toBeUndefined();

    saveMcpServer(db, {
      id: "m2", workspaceId: "ws1", name: "Figma", transport: "http", baseUrl: "https://mcp.figma.com/mcp",
      enabled: true, source: "manual", authMode: "oauth", oauthScope: "read:files",
    });
    const figma = getMcpServerById(db, "m2");
    expect(figma?.authMode).toBe("oauth");
    expect(figma?.oauthScope).toBe("read:files");
  });

  it("defaults disabledTools to [] and round-trips the list", () => {
    saveMcpServer(db, { id: "m1", workspaceId: "ws1", name: "A", transport: "http", baseUrl: "https://a", enabled: true, source: "manual" });
    expect(getMcpServerById(db, "m1")?.disabledTools).toEqual([]);

    saveMcpServer(db, {
      id: "m1", workspaceId: "ws1", name: "A", transport: "http", baseUrl: "https://a",
      enabled: true, source: "manual", disabledTools: ["search-designs", "delete_design"],
    });
    expect(getMcpServerById(db, "m1")?.disabledTools).toEqual(["search-designs", "delete_design"]);

    // Clearing the list persists an empty array, not the previous value.
    saveMcpServer(db, {
      id: "m1", workspaceId: "ws1", name: "A", transport: "http", baseUrl: "https://a",
      enabled: true, source: "manual", disabledTools: [],
    });
    expect(getMcpServerById(db, "m1")?.disabledTools).toEqual([]);
  });
});

// ── External tools: custom services ──────────────────────────────────────────

describe("custom service queries", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeDb();
    seedWorkspace(db);
  });

  it("saves and round-trips responseKeys + method", () => {
    saveCustomService(db, {
      id: "s1", workspaceId: "ws1", name: "Search",
      apiUrl: "https://api.x.com/search", method: "GET",
      headers: { "X-Api-Key": "secret://s1/X-Api-Key" },
      toolDefinition: '{"name":"searchWeb"}',
      responseKeys: ["results", "title", "url"],
      enabled: true, source: "ai-builder",
    });
    const list = getCustomServices(db, "ws1");
    expect(list).toHaveLength(1);
    expect(list[0].method).toBe("GET");
    expect(list[0].responseKeys).toEqual(["results", "title", "url"]);
    expect(list[0].source).toBe("ai-builder");
  });

  it("delete removes the service + its attachments", () => {
    saveCustomService(db, { id: "s1", workspaceId: "ws1", name: "S", apiUrl: "https://a", method: "GET", toolDefinition: "{}", enabled: true, source: "manual" });
    setToolAttachment(db, { projectId: "p1", toolType: "service", toolId: "s1", enabled: true });
    deleteCustomService(db, "s1");
    expect(getCustomServices(db, "ws1")).toHaveLength(0);
    expect(getToolAttachments(db, "p1")).toHaveLength(0);
  });
});

// ── External tools: per-project attachments ──────────────────────────────────

describe("tool attachment queries", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeDb();
    seedWorkspace(db);
  });

  it("sets, updates (upsert), and lists per project", () => {
    setToolAttachment(db, { projectId: "p1", toolType: "mcp", toolId: "m1", enabled: true });
    setToolAttachment(db, { projectId: "p1", toolType: "mcp", toolId: "m1", enabled: false });
    const list = getToolAttachments(db, "p1");
    expect(list).toHaveLength(1);
    expect(list[0].enabled).toBe(false);
  });

  it("distinguishes mcp vs service with the same id", () => {
    setToolAttachment(db, { projectId: "p1", toolType: "mcp", toolId: "x", enabled: true });
    setToolAttachment(db, { projectId: "p1", toolType: "service", toolId: "x", enabled: true });
    expect(getToolAttachments(db, "p1")).toHaveLength(2);
  });

  it("clears a specific attachment", () => {
    setToolAttachment(db, { projectId: "p1", toolType: "mcp", toolId: "m1", enabled: true });
    clearToolAttachment(db, { projectId: "p1", toolType: "mcp", toolId: "m1" });
    expect(getToolAttachments(db, "p1")).toHaveLength(0);
  });
});

describe("deleteNote (soft delete / tombstone)", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeDb();
    seedWorkspace(db);
    seedProject(db);
  });

  it("tombstones the row (kept, but hidden from live reads/search)", () => {
    createNote(db, { id: "n1", projectId: "proj1", workspaceId: "ws1", title: "Doomed", content: "x" });
    expect(getNoteById(db, "n1")).not.toBeNull();
    deleteNote(db, "n1");
    // getNoteById filters tombstones → treated as absent.
    expect(getNoteById(db, "n1")).toBeNull();
    // …but the row survives so the sync staleness guard has something to compare.
    expect(getNoteByIdIncludingTombstoned(db, "n1")).not.toBeNull();
    expect(
      (db.prepare("SELECT deleted_at FROM notes WHERE id='n1'").get() as { deleted_at: string | null }).deleted_at,
    ).not.toBeNull();
    expect(searchNotes(db, { query: "Doomed" }).find((n) => n.id === "n1")).toBeUndefined();
  });

  it("is idempotent — re-deleting preserves deleted_at, updated_at, and version", () => {
    createNote(db, { id: "n1", projectId: "proj1", workspaceId: "ws1", title: "Doomed", content: "x" });
    deleteNote(db, "n1");
    const first = db
      .prepare("SELECT deleted_at, updated_at, version FROM notes WHERE id='n1'")
      .get() as { deleted_at: string; updated_at: string; version: number };
    deleteNote(db, "n1");
    const second = db
      .prepare("SELECT deleted_at, updated_at, version FROM notes WHERE id='n1'")
      .get() as { deleted_at: string; updated_at: string; version: number };
    // The `deleted_at IS NULL` guard means the retry matches zero rows, so none
    // of the tombstone stamps churn.
    expect(second.deleted_at).toBe(first.deleted_at);
    expect(second.updated_at).toBe(first.updated_at);
    expect(second.version).toBe(first.version);
  });

  it("is a no-op for an unknown id", () => {
    expect(() => deleteNote(db, "does-not-exist")).not.toThrow();
  });
});

describe("findTombstonedNotes + getNotes tombstone filtering", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeDb();
    seedWorkspace(db);
    seedProject(db);
  });

  it("lists tombstoned rows WITHOUT removing them, and getNotes hides them", () => {
    createNote(db, { id: "live", projectId: "proj1", workspaceId: "ws1", title: "Live", content: "x" });
    createNote(db, { id: "dead", projectId: "proj1", workspaceId: "ws1", title: "Dead", content: "y" });
    // Simulate a delete that arrived via sync: the row is tombstoned, not removed.
    db.prepare("UPDATE notes SET deleted_at = ? WHERE id = ?").run(new Date().toISOString(), "dead");

    const found = findTombstonedNotes(db);
    expect(found.map((p) => p.id)).toEqual(["dead"]);
    expect(found[0].projectId).toBe("proj1");

    // The tombstone row is KEPT (so the sync staleness guard trips) …
    expect(getNoteByIdIncludingTombstoned(db, "dead")).not.toBeNull();
    // … but getNotes filters it out, so it doesn't show in the UI.
    const listed = getNotes(db, "proj1").map((n: { id: string }) => n.id);
    expect(listed).toContain("live");
    expect(listed).not.toContain("dead");
  });

  it("returns an empty array when there are no tombstones", () => {
    createNote(db, { id: "n1", projectId: "proj1", workspaceId: "ws1", title: "Fine", content: "x" });
    expect(findTombstonedNotes(db)).toEqual([]);
    expect(getNotes(db, "proj1").map((n: { id: string }) => n.id)).toEqual(["n1"]);
  });
});

describe("findNestedConflictCopies", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeDb();
    seedWorkspace(db);
    seedProject(db);
  });

  it("identifies only conflict-of-conflict rows, ignoring originals and single copies", () => {
    createNote(db, { id: "orig", projectId: "proj1", workspaceId: "ws1", title: "Original", content: "x" });
    // A legitimate single-level conflict copy — must NOT be flagged (awaits resolution).
    createNote(db, { id: "orig_conflict_mobile_abc", projectId: "proj1", workspaceId: "ws1", title: "Original (conflicted copy — mobile)", content: "y" });
    // Two nested (junk) copies — must be flagged.
    createNote(db, { id: "orig_conflict_mobile_abc_conflict_desktop_def", projectId: "proj1", workspaceId: "ws1", title: "nested", content: "z" });
    createNote(db, { id: "orig_conflict_desktop_a_conflict_mobile_b_conflict_desktop_c", projectId: "proj1", workspaceId: "ws1", title: "deep", content: "w" });

    const found = findNestedConflictCopies(db);
    expect(found.map((p) => p.id).sort()).toEqual(
      [
        "orig_conflict_desktop_a_conflict_mobile_b_conflict_desktop_c",
        "orig_conflict_mobile_abc_conflict_desktop_def",
      ].sort(),
    );
    // It only reports — it does not delete.
    expect(getNoteById(db, "orig_conflict_mobile_abc_conflict_desktop_def")).not.toBeNull();
  });

  it("returns an empty array when there are no nested conflict copies", () => {
    createNote(db, { id: "orig", projectId: "proj1", workspaceId: "ws1", title: "Original", content: "x" });
    createNote(db, { id: "orig_conflict_mobile_abc", projectId: "proj1", workspaceId: "ws1", title: "copy", content: "y" });
    expect(findNestedConflictCopies(db)).toEqual([]);
  });
});

// ── Codebase index overview ───────────────────────────────────────────────

describe("getCodebaseOverview", () => {
  let db: Database.Database;
  // Absolute, platform-portable root so it survives path.resolve()/path.sep
  // inside the query unchanged (POSIX literals would break the scope match on Windows).
  const root = path.join(os.tmpdir(), "cairn-test-repo");

  beforeEach(() => {
    db = makeDb();
    // Two files under the root, with symbols + one relation.
    upsertCodebaseFile(db, { id: "f1", rootPath: root, filePath: path.join(root, "a.ts"), hash: "h1" });
    upsertCodebaseFile(db, { id: "f2", rootPath: root, filePath: path.join(root, "sub", "b.ts"), hash: "h2" });
    insertCodebaseSymbol(db, { id: "s1", fileId: "f1", name: "Alpha", kind: "class", line: 1, signature: "class Alpha", docstring: null });
    insertCodebaseSymbol(db, { id: "s2", fileId: "f1", name: "doThing", kind: "method", line: 5, signature: "doThing()", docstring: "Does a thing." });
    insertCodebaseSymbol(db, { id: "s3", fileId: "f2", name: "helper", kind: "function", line: 2, signature: "function helper()", docstring: null });
    insertCodebaseRelation(db, { sourceId: "s2", targetName: "helper", type: "call" });
  });

  it("aggregates file, symbol and relation counts", () => {
    const o = getCodebaseOverview(db, root);
    expect(o.fileCount).toBe(2);
    expect(o.totalSymbols).toBe(3);
    expect(o.totalRelations).toBe(1);
    expect(o.roots).toEqual([root]);
  });

  it("breaks symbols down by kind, sorted by count desc", () => {
    const o = getCodebaseOverview(db, root);
    const map = Object.fromEntries(o.kinds.map((k) => [k.kind, k.count]));
    expect(map).toEqual({ class: 1, method: 1, function: 1 });
    // counts are non-increasing
    const counts = o.kinds.map((k) => k.count);
    expect([...counts].sort((a, b) => b - a)).toEqual(counts);
  });

  it("reports per-file symbol and relation counts", () => {
    const o = getCodebaseOverview(db, root);
    const f1 = o.files.find((f) => f.id === "f1")!;
    const f2 = o.files.find((f) => f.id === "f2")!;
    expect(f1.symbol_count).toBe(2);
    expect(f1.relation_count).toBe(1); // doThing → helper originates in f1
    expect(f2.symbol_count).toBe(1);
    expect(f2.relation_count).toBe(0);
  });

  it("scopes to a subfolder (only files under it)", () => {
    const o = getCodebaseOverview(db, path.join(root, "sub"));
    expect(o.fileCount).toBe(1);
    expect(o.files[0].file_path).toBe(path.join(root, "sub", "b.ts"));
    expect(o.totalSymbols).toBe(1);
  });

  it("returns empty aggregates for an unindexed folder", () => {
    const o = getCodebaseOverview(db, path.join(os.tmpdir(), "nothing-here"));
    expect(o.fileCount).toBe(0);
    expect(o.totalSymbols).toBe(0);
    expect(o.totalRelations).toBe(0);
    expect(o.kinds).toEqual([]);
    expect(o.lastIndexedAt).toBeNull();
  });

  it("does not match sibling folders when the path contains a LIKE wildcard", () => {
    // A root literally containing `_` must not act as a wildcard and pull in a
    // sibling folder like `aXb` (where `_` would match any single char).
    const wild = path.join(os.tmpdir(), "cairn_scope");
    const sibling = path.join(os.tmpdir(), "cairnXscope");
    upsertCodebaseFile(db, { id: "w1", rootPath: wild, filePath: path.join(wild, "in.ts"), hash: "hw" });
    upsertCodebaseFile(db, { id: "x1", rootPath: sibling, filePath: path.join(sibling, "out.ts"), hash: "hx" });
    insertCodebaseSymbol(db, { id: "ws", fileId: "w1", name: "inFn", kind: "function", line: 1, signature: "", docstring: null });
    insertCodebaseSymbol(db, { id: "xs", fileId: "x1", name: "outFn", kind: "function", line: 1, signature: "", docstring: null });
    const o = getCodebaseOverview(db, wild);
    expect(o.fileCount).toBe(1);
    expect(o.files[0].file_path).toBe(path.join(wild, "in.ts"));
  });
});

describe("getCodebaseGraph", () => {
  let db: Database.Database;
  const root = path.join(os.tmpdir(), "cairn-graph-repo");

  beforeEach(() => {
    db = makeDb();
    upsertCodebaseFile(db, { id: "f1", rootPath: root, filePath: path.join(root, "a.ts"), hash: "h1" });
    upsertCodebaseFile(db, { id: "f2", rootPath: root, filePath: path.join(root, "b.ts"), hash: "h2" });
    // a.ts defines caller; b.ts defines helper. caller → helper (cross-file).
    insertCodebaseSymbol(db, { id: "s1", fileId: "f1", name: "caller", kind: "function", line: 1, signature: "", docstring: null });
    insertCodebaseSymbol(db, { id: "s2", fileId: "f2", name: "helper", kind: "function", line: 1, signature: "", docstring: null });
    // a self-reference within a.ts must NOT become a file→file edge.
    insertCodebaseSymbol(db, { id: "s3", fileId: "f1", name: "sibling", kind: "function", line: 2, signature: "", docstring: null });
    insertCodebaseRelation(db, { sourceId: "s1", targetName: "helper", type: "call" });
    insertCodebaseRelation(db, { sourceId: "s1", targetName: "sibling", type: "call" });
  });

  it("returns file nodes with symbol counts", () => {
    const g = getCodebaseGraph(db, root);
    expect(g.nodes.map((n) => n.id).sort()).toEqual(["f1", "f2"]);
    expect(g.nodes.find((n) => n.id === "f1")!.symbol_count).toBe(2);
  });

  it("aggregates a directed cross-file edge and drops self-references", () => {
    const g = getCodebaseGraph(db, root);
    expect(g.edges).toHaveLength(1);
    expect(g.edges[0]).toMatchObject({ source: "f1", target: "f2", weight: 1 });
  });

  it("does NOT create edges for ambiguous target names (defined in >1 file)", () => {
    // Add a second file that ALSO defines a symbol named `helper`. Now `helper`
    // is ambiguous, so caller→helper can't be attributed to one file — the edge
    // must be dropped rather than fanning out to every `helper` definition.
    upsertCodebaseFile(db, { id: "f3", rootPath: root, filePath: path.join(root, "c.ts"), hash: "h3" });
    insertCodebaseSymbol(db, { id: "s4", fileId: "f3", name: "helper", kind: "function", line: 1, signature: "", docstring: null });
    const g = getCodebaseGraph(db, root);
    // The caller→helper edge (f1→f2) is gone because `helper` is now ambiguous.
    expect(g.edges.find((e) => e.target === "f2" || e.target === "f3")).toBeUndefined();
    expect(g.nodes.map((n) => n.id).sort()).toEqual(["f1", "f2", "f3"]);
  });
});

describe("getCodebaseModuleGraph", () => {
  let db: Database.Database;
  const root = path.join(os.tmpdir(), "cairn-module-repo");

  beforeEach(() => {
    db = makeDb();
    // Two modules: core/ (a.ts caller, c.ts sibling) and util/ (b.ts helper).
    upsertCodebaseFile(db, { id: "f1", rootPath: root, filePath: path.join(root, "core", "a.ts"), hash: "h1" });
    upsertCodebaseFile(db, { id: "f2", rootPath: root, filePath: path.join(root, "util", "b.ts"), hash: "h2" });
    upsertCodebaseFile(db, { id: "f3", rootPath: root, filePath: path.join(root, "core", "c.ts"), hash: "h3" });
    insertCodebaseSymbol(db, { id: "s1", fileId: "f1", name: "caller", kind: "function", line: 1, signature: "", docstring: null });
    insertCodebaseSymbol(db, { id: "s2", fileId: "f2", name: "helper", kind: "function", line: 1, signature: "", docstring: null });
    insertCodebaseSymbol(db, { id: "s3", fileId: "f3", name: "sibling", kind: "function", line: 1, signature: "", docstring: null });
    // core/a → util/b (cross-module), and core/a → core/c (intra-module cohesion).
    insertCodebaseRelation(db, { sourceId: "s1", targetName: "helper", type: "call" });
    insertCodebaseRelation(db, { sourceId: "s1", targetName: "sibling", type: "call" });
  });

  it("rolls files up into directory modules with aggregated sizes", () => {
    const g = getCodebaseModuleGraph(db, root, 1);
    expect(g.grouping).toBe("directory");
    const core = g.nodes.find((n) => n.id === "core")!;
    const util = g.nodes.find((n) => n.id === "util")!;
    expect(core.fileCount).toBe(2);
    expect(core.symbolCount).toBe(2);
    expect(util.fileCount).toBe(1);
    expect(util.symbolCount).toBe(1);
  });

  it("aggregates cross-module edges and counts intra-module refs as cohesion", () => {
    const g = getCodebaseModuleGraph(db, root, 1);
    // Only the core→util edge crosses modules; core→core is cohesion, not an edge.
    expect(g.edges).toHaveLength(1);
    expect(g.edges[0]).toMatchObject({ source: "core", target: "util", weight: 1 });
    expect(g.nodes.find((n) => n.id === "core")!.internalRefs).toBe(1);
  });
});

describe("mergeProject", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeDb();
    seedWorkspace(db);
    // Source project + its 5 standard columns
    createProject(db, { id: "src", workspaceId: "ws1", name: "Source" });
    createColumn(db, { id: "s_backlog", projectId: "src", workspaceId: "ws1", name: "Backlog", type: "backlog", order: 0 });
    createColumn(db, { id: "s_todo", projectId: "src", workspaceId: "ws1", name: "Todo", type: "todo", order: 1 });
    createColumn(db, { id: "s_done", projectId: "src", workspaceId: "ws1", name: "Done", type: "done", order: 2 });
    // Target project + its 5 standard columns
    createProject(db, { id: "dst", workspaceId: "ws1", name: "Target" });
    createColumn(db, { id: "d_backlog", projectId: "dst", workspaceId: "ws1", name: "Backlog", type: "backlog", order: 0 });
    createColumn(db, { id: "d_todo", projectId: "dst", workspaceId: "ws1", name: "Todo", type: "todo", order: 1 });
    createColumn(db, { id: "d_done", projectId: "dst", workspaceId: "ws1", name: "Done", type: "done", order: 2 });
  });

  it("moves notes and cards to the target, mapping cards by column type", () => {
    createNote(db, { id: "n1", projectId: "src", workspaceId: "ws1", title: "Note A", content: "x" });
    createNote(db, { id: "n2", projectId: "src", workspaceId: "ws1", title: "Note B", content: "y" });
    createCard(db, { id: "c1", columnId: "s_todo", projectId: "src", workspaceId: "ws1", title: "Card in Todo", order: 0 });
    createCard(db, { id: "c2", columnId: "s_done", projectId: "src", workspaceId: "ws1", title: "Card in Done", order: 0 });

    const result = mergeProject(db, "src", "dst");

    expect(result.counts.notes).toBe(2);
    expect(result.counts.cards).toBe(2);

    // Notes now belong to the target project.
    expect(getNotes(db, "dst").map((n) => n.id).sort()).toEqual(["n1", "n2"]);
    expect(getNotes(db, "src")).toHaveLength(0);

    // Cards landed in the target's SAME-TYPE columns.
    const dstCards = getCards(db, { projectId: "dst" });
    const todoCard = dstCards.find((c) => c.id === "c1")!;
    const doneCard = dstCards.find((c) => c.id === "c2")!;
    expect(todoCard.columnId).toBe("d_todo");
    expect(todoCard.projectId).toBe("dst");
    expect(doneCard.columnId).toBe("d_done");

    // Source project is gone.
    expect(getProjectById(db, "src")).toBeNull();
    expect(getProjectById(db, "dst")).not.toBeNull();
  });

  it("recreates custom columns in the target and routes their cards there", () => {
    createColumn(db, { id: "s_custom", projectId: "src", workspaceId: "ws1", name: "Blocked", type: "custom", order: 3 });
    createCard(db, { id: "cc", columnId: "s_custom", projectId: "src", workspaceId: "ws1", title: "Custom card", order: 0 });

    mergeProject(db, "src", "dst");

    const dstCols = getColumns(db, "dst");
    const recreated = dstCols.find((c) => c.name === "Blocked" && c.type === "custom");
    expect(recreated).toBeTruthy();

    const movedCard = getCards(db, { projectId: "dst" }).find((c) => c.id === "cc")!;
    expect(movedCard.columnId).toBe(recreated!.id);
    expect(movedCard.projectId).toBe("dst");
  });

  it("moves idea-flow nodes from the source flow into the target flow", () => {
    const srcFlow = getOrCreateFlow(db, "src");
    createFlowNode(db, { id: "fn1", flowId: srcFlow.id, type: "idea", x: 0, y: 0, data: { title: "hi" } });

    mergeProject(db, "src", "dst");

    const dstFlow = getOrCreateFlow(db, "dst");
    const nodes = getFlowNodes(db, dstFlow.id);
    expect(nodes.map((n) => n.id)).toContain("fn1");
  });

  it("rejects merging a project into itself and unknown projects", () => {
    expect(() => mergeProject(db, "src", "src")).toThrow(/into itself/);
    expect(() => mergeProject(db, "nope", "dst")).toThrow(/Source project not found/);
    expect(() => mergeProject(db, "src", "nope")).toThrow(/Target project not found/);
  });
});

// ── rewriteInboundWikilinks ────────────────────────────────────────────────

describe("rewriteInboundWikilinks", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeDb();
    seedWorkspace(db);
    seedProject(db);
  });

  function mkNote(id: string, title: string, content: string) {
    return createNote(db, { id, projectId: "proj1", workspaceId: "ws1", title, content });
  }

  it("rewrites bare, aliased, and section wikilinks to the new title", () => {
    mkNote("target", "Old Title", "# Old\n\nBody.");
    mkNote("a", "A", "See [[Old Title]] for details.");
    mkNote("b", "B", "Alias: [[Old Title|the old one]].");
    mkNote("c", "C", "Section: [[Old Title#Heading]].");

    const updated = rewriteInboundWikilinks(db, "target", "Old Title", "New Title");

    expect(updated.map((n) => n.id).sort()).toEqual(["a", "b", "c"]);
    expect(getNoteById(db, "a")!.content).toBe("See [[New Title]] for details.");
    expect(getNoteById(db, "b")!.content).toBe("Alias: [[New Title|the old one]].");
    expect(getNoteById(db, "c")!.content).toBe("Section: [[New Title#Heading]].");
  });

  it("does not rewrite a title that is only a PREFIX of another wikilink", () => {
    mkNote("target", "Note", "body");
    mkNote("a", "A", "Link to [[Notebook]] and [[Note]].");

    const updated = rewriteInboundWikilinks(db, "target", "Note", "Journal");

    // [[Notebook]] must survive; only the exact [[Note]] is rewritten.
    expect(getNoteById(db, "a")!.content).toBe("Link to [[Notebook]] and [[Journal]].");
    expect(updated).toHaveLength(1);
  });

  it("returns [] and changes nothing when no note links to the title", () => {
    mkNote("target", "Lonely", "body");
    mkNote("a", "A", "No links here.");
    const updated = rewriteInboundWikilinks(db, "target", "Lonely", "Renamed");
    expect(updated).toEqual([]);
    expect(getNoteById(db, "a")!.content).toBe("No links here.");
  });

  it("skips the renamed note itself and archived/deleted notes", () => {
    mkNote("target", "Old", "Self [[Old]] ref.");
    mkNote("arch", "Arch", "[[Old]]");
    updateNote(db, "arch", { archivedAt: "2025-01-01T00:00:00.000Z" });
    mkNote("del", "Del", "[[Old]]");
    deleteNote(db, "del");
    mkNote("live", "Live", "[[Old]]");

    const updated = rewriteInboundWikilinks(db, "target", "Old", "New");

    expect(updated.map((n) => n.id)).toEqual(["live"]);
    expect(getNoteById(db, "target")!.content).toBe("Self [[Old]] ref."); // untouched
  });

  it("is a no-op when the title is unchanged", () => {
    mkNote("target", "Same", "x");
    mkNote("a", "A", "[[Same]]");
    expect(rewriteInboundWikilinks(db, "target", "Same", "Same")).toEqual([]);
    expect(getNoteById(db, "a")!.content).toBe("[[Same]]");
  });
});
