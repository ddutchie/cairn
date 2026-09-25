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
  getOrCreateFlow,
  createFlowNode,
  updateFlowNode,
  changeFeedHead,
  getChangesSince,
  recordOwnWrite,
  pruneChangeFeed,
} from "./queries";

function makeDb(): Database.Database {
  const db = new BetterSqlite3(":memory:");
  applySchema(db);
  createWorkspace(db, { id: "ws1", name: "WS" });
  createProject(db, { id: "p1", workspaceId: "ws1", name: "Proj" });
  return db;
}

const note = (id: string, title = id) =>
  ({ id, projectId: "p1", workspaceId: "ws1", title, content: `${title} body` });

describe("change feed", () => {
  let db: Database.Database;
  let feedId: string;
  let cursor: number;

  beforeEach(() => {
    db = makeDb();
    const init = getChangesSince(db, null, null, 1);
    feedId = init.feedId;
    cursor = init.head;
    expect(init.reset).toBe(false);
  });

  it("returns only the rows changed since the cursor, in their snapshot shape", () => {
    createNote(db, note("n1"));
    createNote(db, note("n2"));
    const cs = getChangesSince(db, cursor, feedId, 1);
    expect(cs.reset).toBe(false);
    expect(cs.head).toBeGreaterThan(cursor);
    expect(cs.touched).toEqual(["notes"]);
    expect((cs.upserts.notes as Array<{ id: string; title: string }>).map((n) => n.id).sort()).toEqual(["n1", "n2"]);
    // Nothing new → empty changeset at the same head.
    const again = getChangesSince(db, cs.head, feedId, 1);
    expect(again.touched).toEqual([]);
    expect(again.head).toBe(cs.head);
  });

  it("reports deleted rows as removed (physical delete and tombstone alike)", () => {
    createNote(db, note("n1"));
    createNote(db, note("n2"));
    cursor = changeFeedHead(db);
    deleteNote(db, "n1");
    db.prepare("UPDATE notes SET deleted_at = ? WHERE id = 'n2'").run(new Date().toISOString());
    const cs = getChangesSince(db, cursor, feedId, 1);
    expect(cs.upserts.notes).toBeUndefined();
    expect(cs.removed.notes?.sort()).toEqual(["n1", "n2"]);
  });

  it("skips a window's own writes for that window only", () => {
    const before = changeFeedHead(db);
    createNote(db, note("mine"));
    recordOwnWrite(db, before, changeFeedHead(db), /* sender */ 1);
    updateNote(db, "mine", { title: "renamed elsewhere" }); // external (e.g. MCP)

    // Window 1 wrote the insert but not the later update → still gets the row.
    const w1 = getChangesSince(db, cursor, feedId, 1);
    expect(w1.externalTouched).toEqual(["notes"]);
    expect((w1.upserts.notes as Array<{ title: string }>)[0].title).toBe("renamed elsewhere");

    // A pure own write produces no upserts for its window…
    const c2 = changeFeedHead(db);
    createNote(db, note("mine2"));
    recordOwnWrite(db, c2, changeFeedHead(db), 1);
    const own = getChangesSince(db, c2, feedId, 1);
    expect(own.touched).toEqual(["notes"]);
    expect(own.externalTouched).toEqual([]);
    expect(own.upserts).toEqual({});
    // …but is external to another window (e.g. the chat pop-out).
    const other = getChangesSince(db, c2, feedId, 2);
    expect((other.upserts.notes as Array<{ id: string }>).map((n) => n.id)).toEqual(["mine2"]);
  });

  it("forces a full reset on a feed id mismatch, a future cursor, or a pruned gap", () => {
    expect(getChangesSince(db, cursor, "other-db", 1).reset).toBe(true);
    expect(getChangesSince(db, cursor + 1000, feedId, 1).reset).toBe(true);

    const start = changeFeedHead(db);
    const insert = db.prepare("INSERT INTO change_feed (entity, entity_id) VALUES ('notes', 'x')");
    db.transaction(() => { for (let i = 0; i < 12_500; i++) insert.run(); })();
    pruneChangeFeed(db);
    expect(getChangesSince(db, start, feedId, 1).reset).toBe(true);
    // A cursor inside the retained window still works.
    expect(getChangesSince(db, changeFeedHead(db) - 5, feedId, 1).reset).toBe(false);
  });

  it("coalesces signal-table bursts into one row while still advancing the head", () => {
    const flow = getOrCreateFlow(db, "p1") as { id: string };
    createFlowNode(db, { id: "fn1", flowId: flow.id, type: "idea", x: 0, y: 0, data: {} });
    const start = changeFeedHead(db);
    for (let i = 1; i <= 50; i++) updateFlowNode(db, "fn1", { x: i });
    const cs = getChangesSince(db, start, feedId, 1);
    expect(cs.head).toBeGreaterThan(start);
    expect(cs.touched).toEqual(["idea_flow_nodes"]);
    const rows = db.prepare("SELECT COUNT(*) AS c FROM change_feed WHERE seq > ?").get(start) as { c: number };
    expect(rows.c).toBe(1);
  });

  it("does not record writes to tables the UI never shows", () => {
    const start = changeFeedHead(db);
    db.prepare("INSERT INTO sync_state (key, value) VALUES ('probe', '1')").run();
    expect(changeFeedHead(db)).toBe(start);
  });
});
