/**
 * Mobile built-in tool definitions: every schema well-formed, and the payload
 * sent with every agent request stays within budget. Native/RN modules are
 * mocked so the real TOOLS list loads under plain Node.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { encode } from "gpt-tokenizer";
// The vitest shim loads better-sqlite3 from the provisioned vitest-native/ copy, like the root node project does.
import BetterSqlite3 from "../../../vitest-sqlite-shim.cjs";
import type Database from "better-sqlite3";
import { MOBILE_SCHEMA_SQL, MOBILE_TRIGGERS_SQL } from "../db/schema";
import { TOOL_SCHEMAS, toolSchemasFor } from "../../../electron/lib/tool-schemas";
import { createExpoSyncDb } from "../db/expo-sync-db";
import { PEOPLE_TOOL_ARGS } from "../../../shared/agent/people-tools";

const q = vi.hoisted(() => ({
  getNote: vi.fn(), getNoteForAgent: vi.fn(), getNoteRange: vi.fn(), getCard: vi.fn(),
  listColumns: vi.fn(), listCards: vi.fn(), listProjects: vi.fn((): Record<string, unknown>[] => []), searchTasks: vi.fn((): Record<string, unknown>[] => []),
  listReadyCards: vi.fn((): Record<string, unknown>[] => []), listCardsWithDueDates: vi.fn((): Record<string, unknown>[] => []),
  patchNote: vi.fn(() => ({ ok: true })), appendToNote: vi.fn(() => true),
  moveCardToColumn: vi.fn(), updateTask: vi.fn(), archiveCard: vi.fn(), tagTask: vi.fn(() => ({ id: "x", tagIds: [] })),
  linkNoteToTask: vi.fn(() => ({ linked: true })), unlinkNoteFromTask: vi.fn(() => ({ unlinked: true })),
  createTask: vi.fn(() => "new-card"), softDeleteNote: vi.fn(), deleteCard: vi.fn(),
  renameNote: vi.fn(() => ({ title: "t" })), moveNotesToFolder: vi.fn(() => 1), pinNote: vi.fn(), tagNote: vi.fn(() => ({ id: "x", tagIds: [] })),
  ensureNote: vi.fn((): string => "n-new"), findNoteByTitle: vi.fn((): { id: string } | null => null),
  workspaceIdForPerson: vi.fn((): string | undefined => undefined),
  searchNotes: vi.fn((): Record<string, unknown>[] => []), listNotes: vi.fn((): Record<string, unknown>[] => []),
}));
// The People layer: a real SQLite database (the mobile schema) behind the shared queries, and a switchable flag.
const people = vi.hoisted(() => ({ db: null as unknown, enabled: true }));
vi.mock("@/db/queries", () => q);
vi.mock("@/db/people", () => ({ peopleDb: () => people.db, peopleWorkspaceId: () => "ws1" }));
vi.mock("@/people/flag", () => ({ isPeopleEnabled: () => people.enabled }));
vi.mock("@/sync/write-signal", () => ({ notifyLocalWrite: () => {} }));
vi.mock("@/notes/embeddings", () => ({}));
vi.mock("@modules/apple-embeddings", () => ({ isAppleEmbeddingsSupported: () => false }));
vi.mock("./services", () => ({ serviceToolDefs: () => [] }));
vi.mock("./tool-toggles", () => ({ isToolEnabled: () => true }));
vi.mock("./mcp-store", () => ({ getCachedMcpToolDefs: () => [], getInstalledMcpServer: () => undefined, toRuntimeConfig: () => ({}) }));
vi.mock("./mcp-client", () => ({}));

const { TOOLS, WRITE_TOOL_NAMES, TOOL_MAP, builtinTools } = await import("./tools");
const run = (name: string, args: Record<string, unknown>) => TOOL_MAP.get(name)!.run(args) as Promise<Record<string, unknown>> | Record<string, unknown>;

/** Tokens for the tool list as the agent request carries it. */
function payloadTokens(): number {
  return encode(JSON.stringify(TOOLS.map((t) => ({ name: t.name, description: t.description, parameters: t.jsonSchema })))).length;
}

describe("mobile built-in tools", () => {
  it("have unique names and well-formed object schemas", () => {
    expect(new Set(TOOLS.map((t) => t.name)).size).toBe(TOOLS.length);
    for (const t of TOOLS) {
      const s = t.jsonSchema as { type?: string; properties?: Record<string, unknown>; required?: string[] };
      expect(s.type, t.name).toBe("object");
      for (const r of s.required ?? []) expect(Object.keys(s.properties ?? {}), `${t.name}.${r}`).toContain(r);
    }
  });

  it("only list real tools as writes", () => {
    const names = new Set(TOOLS.map((t) => t.name));
    for (const w of WRITE_TOOL_NAMES) expect(names.has(w), w).toBe(true);
  });

  it("reports the payload size", () => {
    console.log(`mobile built-in tools: ${TOOLS.length} tools, ${payloadTokens()} tokens`);
    expect(payloadTokens()).toBeGreaterThan(0);
  });
});

describe("mobile consolidated tools route to the right queries", () => {
  it("get_item reads a note (outline by default, a line range on request) or a card", async () => {
    q.getNote.mockImplementation((id: string) => (id === "n1" ? { id: "n1" } : null));
    q.getNoteForAgent.mockReturnValue({ id: "n1", outline: [] });
    q.getNoteRange.mockReturnValue({ id: "n1", content: "slice" });
    q.getCard.mockImplementation((id: string) => (id === "c1" ? { id: "c1", title: "Card" } : null));
    expect(await run("get_item", { id: "n1" })).toMatchObject({ type: "note", outline: [] });
    expect(await run("get_item", { id: "n1", startLine: 3, endLine: 9 })).toMatchObject({ type: "note", content: "slice" });
    expect(q.getNoteRange).toHaveBeenCalledWith("n1", 3, 9);
    expect(await run("get_item", { id: "c1" })).toMatchObject({ type: "task", title: "Card" });
    expect((await run("get_item", { id: "zz" })).error).toMatch(/No note or task/);
  });

  it("edit_note patches with oldString and appends without it", async () => {
    await run("edit_note", { noteId: "n1", oldString: "a", newString: "b" });
    expect(q.patchNote).toHaveBeenCalledWith("n1", "a", "b");
    await run("edit_note", { noteId: "n1", newString: "tail" });
    expect(q.appendToNote).toHaveBeenCalledWith("n1", "tail");
  });

  it("update_tasks resolves columnType per card's project and reports per-card failures", async () => {
    q.getCard.mockImplementation((id: string) => (id === "c1" ? { id: "c1", title: "A", project_id: "p", column_id: "todo" } : null));
    q.listColumns.mockReturnValue([{ id: "todo", type: "todo" }, { id: "doing", type: "in_progress" }]);
    const res = await run("update_tasks", { cardIds: ["c1", "missing"], columnType: "in_progress", priority: "high" });
    expect(q.moveCardToColumn).toHaveBeenCalledWith("c1", "doing");
    expect(q.updateTask).toHaveBeenCalledWith("c1", { priority: "high" });
    expect(res.error).toMatch(/missing: Task not found/);
  });

  it("create_task defaults to the backlog column and applies due date, tags and links", async () => {
    q.listColumns.mockReturnValue([{ id: "todo", type: "todo" }, { id: "back", type: "backlog" }]);
    const res = await run("create_task", { projectId: "p", title: "Ship", dueDate: "2026-11-01", tagNames: ["x"], linkNoteIds: ["n1"] });
    expect(q.createTask).toHaveBeenCalledWith("p", "back", "Ship", { description: undefined, priority: undefined });
    expect(q.updateTask).toHaveBeenCalledWith("new-card", { dueDate: "2026-11-01" });
    expect(q.linkNoteToTask).toHaveBeenCalledWith("n1", "new-card");
    expect(res).toMatchObject({ id: "new-card", columnId: "back" });
  });

  it("search_tasks filter:'overdue' keeps open past-due cards only", async () => {
    q.listCardsWithDueDates.mockReturnValue([
      { id: "late", title: "Late", priority: "low", column_id: "todo", project_id: "p", due_date: "2000-01-01", is_done: 0 },
      { id: "doneLate", title: "Done", priority: "low", column_id: "done", project_id: "p", due_date: "2000-01-01", is_done: 1 },
      { id: "future", title: "Later", priority: "low", column_id: "todo", project_id: "p", due_date: "2999-01-01", is_done: 0 },
    ]);
    const res = await run("search_tasks", { query: "", filter: "overdue" }) as unknown as { id: string }[];
    expect(res.map((c) => c.id)).toEqual(["late"]);
  });

  it("delete routes by type", async () => {
    await run("delete", { type: "note", id: "n1" });
    expect(q.softDeleteNote).toHaveBeenCalledWith("n1");
    await run("delete", { type: "task", id: "c1" });
    expect(q.deleteCard).toHaveBeenCalledWith("c1");
  });
});


// ── People layer ─────────────────────────────

/** A fresh mobile-shaped database with one workspace, a project, notes and a few people. */
function seedPeopleDb(): Database.Database {
  const db = new (BetterSqlite3 as unknown as new (f: string) => Database.Database)(":memory:");
  db.exec(MOBILE_SCHEMA_SQL);
  db.exec(MOBILE_TRIGGERS_SQL);
  const now = "2026-11-18T10:00:00.000Z";
  db.prepare("INSERT INTO workspaces (id, name, created_at, updated_at) VALUES ('ws1', 'W', ?, ?)").run(now, now);
  const note = db.prepare("INSERT INTO notes (id, project_id, workspace_id, title, content, created_at, updated_at) VALUES (?, 'p1', 'ws1', ?, ?, ?, ?)");
  note.run("n1", "Weekly sync", "- [ ] **Chris** - ship it\n", now, now);
  note.run("persona-chris", "Chris Sponagle", "Private notes about Chris", now, now);
  note.run("persona-ana", "Ana Ruiz", "About Ana", now, now);
  const person = db.prepare(`INSERT INTO people (id, workspace_id, name, aliases, emails, persona_note_id, agent_private, created_at, updated_at)
    VALUES (?, 'ws1', ?, '[]', '[]', ?, ?, ?, ?)`);
  person.run("chris", "Chris Sponagle", "persona-chris", 1, now, now);
  person.run("ana", "Ana Ruiz", "persona-ana", 0, now, now);
  db.prepare("INSERT INTO task_cards (id, column_id, project_id, workspace_id, title, created_at, updated_at) VALUES ('c1', 'col', 'p1', 'ws1', 'Card', ?, ?)").run(now, now);
  return db;
}

const props = (t: AnyTool) => Object.keys((t.jsonSchema as { properties: Record<string, unknown> }).properties);
type AnyTool = { name: string; description: string; params: string; jsonSchema: Record<string, unknown>; run: (a: Record<string, unknown>) => unknown };
const toolByName = (list: readonly { name: string }[], name: string) => list.find((t) => t.name === name) as AnyTool | undefined;

describe("People layer: the flag decides what the model sees", () => {
  it("leaves out the people tool and every People argument while the flag is off", () => {
    const off = builtinTools(false);
    expect(toolByName(off, "people")).toBeUndefined();
    for (const [tool, args] of Object.entries(PEOPLE_TOOL_ARGS)) {
      const t = toolByName(off, tool)!;
      for (const a of args) {
        expect(props(t), `${tool}.${a} in schema`).not.toContain(a);
        expect(t.params, `${tool}.${a} in hint`).not.toContain(`"${a}"`);
      }
    }
    expect(JSON.stringify(off)).not.toMatch(/attendee|persona|person/i);
  });

  it("offers them when the flag is on", () => {
    const on = builtinTools(true);
    expect(toolByName(on, "people")).toBeDefined();
    for (const [tool, args] of Object.entries(PEOPLE_TOOL_ARGS)) {
      const t = toolByName(on, tool)!;
      for (const a of args) {
        expect(props(t)).toContain(a);
        expect(t.params).toContain(`"${a}"`);
      }
    }
  });

  it("reads the flag per call by default", () => {
    people.enabled = false;
    expect(builtinTools().some((t) => t.name === "people")).toBe(false);
    people.enabled = true;
    expect(builtinTools().some((t) => t.name === "people")).toBe(true);
  });

  it("matches the desktop schema field for field", () => {
    const desktop = TOOL_SCHEMAS.people.schema.shape;
    const mobile = toolByName(TOOLS, "people")!;
    expect(props(mobile).sort()).toEqual(Object.keys(desktop).sort());
    const action = (mobile.jsonSchema as { properties: { action: { enum: string[] } } }).properties.action.enum;
    expect(action).toEqual(desktop.action.options);
    expect(mobile.description).toBe(TOOL_SCHEMAS.people.description);
    // The arguments on other tools exist on both, with the same words.
    const desktopOff = toolSchemasFor({ people: false });
    for (const [tool, args] of Object.entries(PEOPLE_TOOL_ARGS)) {
      for (const a of args) {
        const d = (TOOL_SCHEMAS as Record<string, { schema: { shape: Record<string, { description?: string }> } }>)[tool].schema.shape[a];
        expect(Object.keys(desktopOff[tool].schema.shape)).not.toContain(a);
        expect((toolByName(TOOLS, tool)!.jsonSchema as { properties: Record<string, { description?: string }> }).properties[a].description).toBe(d.description);
      }
    }
  });

  it("lists people among the write tools", () => {
    expect(WRITE_TOOL_NAMES.has("people")).toBe(true);
  });
});

describe("People layer: the tools write through the shared code", () => {
  let db: Database.Database;
  const call = (name: string, args: Record<string, unknown>) => toolByName(builtinTools(true), name)!.run(args) as Promise<Record<string, unknown>>;
  const people_ = (args: Record<string, unknown>) => call("people", args);

  beforeEach(() => {
    db = seedPeopleDb();
    people.db = db;
    people.enabled = true;
    q.getNote.mockImplementation((id: string) => (db.prepare("SELECT id, title FROM notes WHERE id = ?").get(id) ?? null));
  });

  it("upserts and queries a person, suggested when inferred", async () => {
    const made = await people_({ action: "upsert", name: "Dana Lee", provenance: "inferred", relationships: [{ type: "peer" }] });
    expect(made).toMatchObject({ created: true, person: { name: "Dana Lee", status: "suggested" } });
    const list = await people_({ action: "query", name: "dana" });
    expect((list.people as { name: string }[]).map((p) => p.name)).toEqual(["Dana Lee"]);
    expect(await people_({ action: "upsert", name: "Dana Lee", cadence: "weekly" })).toMatchObject({ updated: true, person: { cadence: "weekly" } });
  });

  it("links an attendee with a manual claim, staged for sync", async () => {
    const r = await people_({ action: "link", link: "attendee", personId: "ana", noteId: "n1" });
    expect(r).toMatchObject({ linked: true });
    const row = db.prepare("SELECT source, sources FROM meeting_attendees WHERE person_id = 'ana' AND deleted_at IS NULL").get() as { source: string; sources: string };
    expect(row.source).toBe("declared");
    expect(JSON.parse(row.sources)).toMatchObject({ declared: { on: true } });
    // The capture triggers staged it (generated from SYNCABLE_TABLES).
    const staged = db.prepare("SELECT entity FROM sync_pending").all() as { entity: string }[];
    expect(staged.map((s) => s.entity)).toEqual(expect.arrayContaining(["meetings", "meeting_attendees", "notes"]));
  });

  it("ensure_note with attendees makes the note a meeting and reports who needs confirming", async () => {
    q.ensureNote.mockReturnValue("n1");
    const r = await call("ensure_note", { projectId: "p1", title: "Weekly sync", content: "x", attendees: ["Ana Ruiz", "Unknown Person"], date: "2026-11-11" });
    expect(r).toMatchObject({ id: "n1", meeting: { attendees: expect.arrayContaining(["Ana Ruiz"]) } });
    const meeting = db.prepare("SELECT m.starts_at AS at FROM notes n JOIN meetings m ON m.id = n.meeting_id WHERE n.id = 'n1'").get() as { at: string };
    expect(meeting.at.startsWith("2026-11-11")).toBe(true);
  });

  it("an unknown attendee name works on an expo-style database (BEGIN-only transactions, no nesting)", async () => {
    // expo-sqlite's withTransactionSync is a bare BEGIN/COMMIT: nesting throws unless the adapter uses savepoints.
    let inTx = false;
    const expoLike = {
      prepareSync: (sql: string) => {
        const st = db.prepare(sql);
        return {
          executeSync: (params: unknown[]) => {
            if (st.reader) {
              const rows = st.all(...params);
              return { changes: 0, lastInsertRowId: 0, getFirstSync: () => rows[0] ?? null, getAllSync: () => rows };
            }
            const r = st.run(...params);
            return { changes: r.changes, lastInsertRowId: Number(r.lastInsertRowid), getFirstSync: () => null, getAllSync: () => [] };
          },
          finalizeSync: () => {},
        };
      },
      execSync: (sql: string) => { db.exec(sql); },
      withTransactionSync: (fn: () => void) => {
        if (inTx) throw new Error("cannot start a transaction within a transaction");
        inTx = true;
        db.exec("BEGIN");
        try { fn(); db.exec("COMMIT"); } catch (e) { db.exec("ROLLBACK"); throw e; } finally { inTx = false; }
      },
    };
    people.db = createExpoSyncDb(expoLike as never);
    q.ensureNote.mockReturnValue("n1");
    const r = await call("ensure_note", { projectId: "p1", title: "Weekly sync", content: "x", attendees: ["Priya Nair"] });
    expect(r.error).toBeUndefined();
    expect(r).toMatchObject({ id: "n1", meeting: expect.anything() });
    const stub = db.prepare("SELECT name FROM people WHERE name = 'Priya Nair' AND deleted_at IS NULL").get();
    expect(stub).toBeTruthy();
  });

  it("a People failure after the note is written is reported, not thrown", async () => {
    q.ensureNote.mockReturnValue("n1");
    people.db = { prepare: () => { throw new Error("db locked"); }, transaction: () => () => { throw new Error("db locked"); } };
    const r = await call("ensure_note", { projectId: "p1", title: "Weekly sync", content: "x", attendees: ["Ana Ruiz"] });
    expect(r).toMatchObject({ id: "n1" });
    expect(String(r.error)).toMatch(/attendees n1: db locked/);
  });

  it("update_tasks and create_task set the owner; an empty owner clears it", async () => {
    q.getCard.mockImplementation((id: string) => (id === "c1" ? { id: "c1", title: "Card", project_id: "p1", column_id: "col" } : null));
    expect(await call("update_tasks", { cardIds: ["c1"], owner: "Ana Ruiz" })).toMatchObject({ owner: { id: "ana" } });
    expect((db.prepare("SELECT owner_person_id AS o FROM task_cards WHERE id = 'c1'").get() as { o: string }).o).toBe("ana");
    await call("update_tasks", { cardIds: ["c1"], owner: "" });
    expect((db.prepare("SELECT owner_person_id AS o FROM task_cards WHERE id = 'c1'").get() as { o: string | null }).o).toBeNull();
    const bad = await call("update_tasks", { cardIds: ["c1"], owner: "Nobody Here" });
    expect(String(bad.error)).toMatch(/owner/);
  });

  it("ignores the People arguments while the flag is off", async () => {
    people.enabled = false;
    q.ensureNote.mockReturnValue("n1");
    const r = await toolByName(builtinTools(false), "ensure_note")!.run({ projectId: "p1", title: "Weekly sync", content: "x", attendees: ["Ana Ruiz"] }) as Record<string, unknown>;
    expect(r).toEqual({ id: "n1" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM meetings").get()).toEqual({ n: 0 });
  });
});

describe("People layer: private persona notes stay out of agent reads", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = seedPeopleDb();
    people.db = db;
    q.getNote.mockImplementation((id: string) => (db.prepare("SELECT id, title FROM notes WHERE id = ?").get(id) ?? null));
    q.searchNotes.mockReset();
  });
  const tool = (flag: boolean, name: string) => toolByName(builtinTools(flag), name)!;

  for (const flag of [true, false]) {
    it(`drops the private persona note from search results and answers "Not found" for it (flag ${flag ? "on" : "off"})`, async () => {
      people.enabled = flag;
      q.searchNotes.mockReturnValue([
        { id: "persona-chris", title: "Chris Sponagle", folder: "", project_id: "p1" },
        { id: "persona-ana", title: "Ana Ruiz", folder: "", project_id: "p1" },
      ]);
      const hits = await tool(flag, "search_notes").run({ query: "persona" }) as { id: string }[];
      expect(hits.map((h) => h.id)).toEqual(["persona-ana"]);
      expect(await tool(flag, "get_item").run({ id: "persona-chris" })).toEqual({ error: "Not found" });
    });
  }

  it("refuses to edit or re-create a private persona note", async () => {
    people.enabled = true;
    expect(await tool(true, "edit_note").run({ noteId: "persona-chris", newString: "x" })).toEqual({ error: "Not found" });
    expect(q.appendToNote).not.toHaveBeenCalled();
    q.findNoteByTitle.mockReturnValue({ id: "persona-chris" });
    expect(String(((await tool(true, "ensure_note").run({ projectId: "p1", title: "Chris Sponagle", content: "x" })) as { error: string }).error)).toMatch(/can't be used/);
    expect(q.ensureNote).not.toHaveBeenCalled();
  });

  it("keeps the persona note id out of the people tool, for every read action", async () => {
    people.enabled = true;
    const run = (args: Record<string, unknown>) => tool(true, "people").run(args);
    for (const args of [
      { action: "query", name: "chris" },
      { action: "get", personId: "chris" },
      { action: "timeline", personId: "chris" },
      { action: "relationships", personId: "chris" },
    ]) {
      const out = JSON.stringify(await run(args));
      expect(out, JSON.stringify(args)).not.toContain("persona-chris");
    }
    // The private person is still known, just without their note.
    expect(await run({ action: "get", personId: "chris" })).toMatchObject({ id: "chris", name: "Chris Sponagle" });
    // An agent can't link the private note either.
    expect(await run({ action: "upsert", personId: "chris", personaNoteId: "persona-chris" })).toEqual({ error: "Not found" });
    // Another person's note is unaffected.
    expect(JSON.stringify(await run({ action: "get", personId: "ana" }))).toContain("persona-ana");
  });
});
