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
  deleteNote,
  getNoteById,
  createColumn,
  createCard,
  updateCard,
  getCards,
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

describe("deleteNote (hard delete)", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeDb();
    seedWorkspace(db);
    seedProject(db);
  });

  it("physically removes the row (desktop lists don't filter tombstones)", () => {
    createNote(db, { id: "n1", projectId: "proj1", workspaceId: "ws1", title: "Doomed", content: "x" });
    expect(getNoteById(db, "n1")).not.toBeNull();
    deleteNote(db, "n1");
    expect(getNoteById(db, "n1")).toBeNull();
    expect(searchNotes(db, { query: "Doomed" }).find((n) => n.id === "n1")).toBeUndefined();
  });

  it("is a no-op for an unknown id", () => {
    expect(() => deleteNote(db, "does-not-exist")).not.toThrow();
  });
});

// ── Codebase index overview ───────────────────────────────────────────────

describe("getCodebaseOverview", () => {
  let db: Database.Database;
  // Absolute root so it survives path.resolve() inside the query unchanged.
  const root = "/tmp/cairn-test-repo";

  beforeEach(() => {
    db = makeDb();
    // Two files under the root, with symbols + one relation.
    upsertCodebaseFile(db, { id: "f1", rootPath: root, filePath: `${root}/a.ts`, hash: "h1" });
    upsertCodebaseFile(db, { id: "f2", rootPath: root, filePath: `${root}/sub/b.ts`, hash: "h2" });
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
    const o = getCodebaseOverview(db, `${root}/sub`);
    expect(o.fileCount).toBe(1);
    expect(o.files[0].file_path).toBe(`${root}/sub/b.ts`);
    expect(o.totalSymbols).toBe(1);
  });

  it("returns empty aggregates for an unindexed folder", () => {
    const o = getCodebaseOverview(db, "/tmp/nothing-here");
    expect(o.fileCount).toBe(0);
    expect(o.totalSymbols).toBe(0);
    expect(o.totalRelations).toBe(0);
    expect(o.kinds).toEqual([]);
    expect(o.lastIndexedAt).toBeNull();
  });
});
