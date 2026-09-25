import { describe, it, expect, beforeEach } from "vitest";
import BetterSqlite3 from "better-sqlite3";
import type Database from "better-sqlite3";
import { applySchema } from "./schema";
import {
  createWorkspace,
  createProject,
  createNote,
  updateNote,
  getRendererSnapshot,
  getFullSnapshot,
  getNoteBodies,
  searchNoteIds,
  wikilinkBacklinkIds,
  getChangesSince,
  changeFeedHead,
  clearNoteChangeBase,
  noteChangeBaseHead,
  discardNoteChangeBasesSince,
  pruneNoteChangeBases,
} from "./queries";
import { NOTE_EXCERPT_CHARS } from "../../shared/notes/excerpt";

function makeDb(): Database.Database {
  const db = new BetterSqlite3(":memory:");
  applySchema(db);
  createWorkspace(db, { id: "ws1", name: "WS" });
  createProject(db, { id: "p1", workspaceId: "ws1", name: "One" });
  createProject(db, { id: "p2", workspaceId: "ws1", name: "Two" });
  return db;
}

const mk = (db: Database.Database, id: string, title: string, content: string, projectId = "p1", type?: "note" | "dashboard") =>
  createNote(db, { id, projectId, workspaceId: "ws1", title, content, ...(type ? { type } : {}) });

describe("lazy note bodies — main-process queries", () => {
  let db: Database.Database;
  beforeEach(() => { db = makeDb(); });

  it("renderer snapshot carries note metadata + excerpt but no body", () => {
    const long = "# Heading\n\n" + "word ".repeat(2000);
    mk(db, "n1", "Long", long);
    const [n] = getRendererSnapshot(db).notes;
    expect(n).not.toHaveProperty("content");
    expect(n.title).toBe("Long");
    expect(n.contentText.startsWith("Heading")).toBe(true);
    expect(n.contentText.length).toBeLessThanOrEqual(NOTE_EXCERPT_CHARS);
    // The excerpt matches what a full read produces.
    expect(n.contentText).toBe(getFullSnapshot(db).notes[0].contentText);
  });

  it("returns bodies by id, skipping deleted and unknown ids", () => {
    mk(db, "n1", "A", "alpha body");
    mk(db, "n2", "B", "beta body");
    db.prepare("UPDATE notes SET deleted_at = ? WHERE id = 'n2'").run(new Date().toISOString());
    const bodies = getNoteBodies(db, ["n1", "n2", "missing"]);
    expect(bodies.map((b) => [b.id, b.content])).toEqual([["n1", "alpha body"]]);
  });

  it("search matches AND-of-terms across title + stripped body, newest first", () => {
    mk(db, "n1", "Login pipeline", "covers **auth** and refresh");
    mk(db, "n2", "Unrelated", "nothing here");
    mk(db, "n3", "Auth notes", "the login flow");
    updateNote(db, "n3", { title: "Auth notes" }); // bump updated_at → newest
    expect(searchNoteIds(db, "login auth")).toEqual(["n3", "n1"]);
    expect(searchNoteIds(db, "auth missing")).toEqual([]);
    expect(searchNoteIds(db, "  ")).toEqual([]);
  });

  it("search scopes to a project and ignores dashboard bodies", () => {
    mk(db, "n1", "Plan", "roadmap details", "p1");
    mk(db, "n2", "Plan", "roadmap details", "p2");
    mk(db, "d1", "Board", "<div>roadmap</div>", "p1", "dashboard");
    expect(searchNoteIds(db, "roadmap", { projectId: "p1" })).toEqual(["n1"]);
  });

  it("search handles non-ASCII terms (no SQL prefilter for them)", () => {
    mk(db, "n1", "Überblick", "Große Änderung");
    expect(searchNoteIds(db, "änderung")).toEqual(["n1"]);
    expect(searchNoteIds(db, "überblick große")).toEqual(["n1"]);
  });

  it("finds incoming [[wikilinks]] case-insensitively, trimmed, excluding self", () => {
    mk(db, "target", "Design Doc", "self mention [[Design Doc]]");
    mk(db, "a", "A", "see [[ design doc ]] for more");
    mk(db, "b", "B", "see [[Design Docs]] (different)");
    mk(db, "c", "C", "plain design doc text, no link");
    expect(wikilinkBacklinkIds(db, "target")).toEqual(["a"]);
  });

  it("returns no backlinks for a deleted (tombstoned) target", () => {
    mk(db, "target", "Design Doc", "");
    mk(db, "a", "A", "see [[Design Doc]]");
    db.prepare("UPDATE notes SET deleted_at = ? WHERE id = 'target'").run(new Date().toISOString());
    expect(wikilinkBacklinkIds(db, "target")).toEqual([]);
  });

  it("change feed delivers note upserts without bodies", () => {
    const init = getChangesSince(db, null, null, 1);
    mk(db, "n1", "Title", "some body text");
    const cs = getChangesSince(db, init.head, init.feedId, 1);
    const [n] = cs.upserts.notes as Array<Record<string, unknown>>;
    expect(n.id).toBe("n1");
    expect(n).not.toHaveProperty("content");
    expect(n.contentText).toBe("some body text");
    expect(cs.head).toBe(changeFeedHead(db));
  });
});

describe("what's new baselines (note_change_base)", () => {
  let db: Database.Database;
  beforeEach(() => { db = makeDb(); });
  const base = (id: string) =>
    db.prepare("SELECT previous_content FROM note_change_base WHERE note_id = ?").get(id) as { previous_content: string } | undefined;

  it("keeps the body from before the FIRST unseen change and serves it with the body", () => {
    mk(db, "n1", "Plan", "v1");
    updateNote(db, "n1", { content: "v2" }); // e.g. MCP
    updateNote(db, "n1", { content: "v3" }); // e.g. sync
    expect(base("n1")?.previous_content).toBe("v1");
    const [b] = getNoteBodies(db, ["n1"]);
    expect(b.content).toBe("v3");
    expect(b.previousContent).toBe("v1");
    expect(b.changedAt).toBeTruthy();
  });

  it("ignores metadata-only updates and clears once seen", () => {
    mk(db, "n1", "Plan", "v1");
    updateNote(db, "n1", { isPinned: true });
    expect(base("n1")).toBeUndefined();
    updateNote(db, "n1", { content: "v2" });
    clearNoteChangeBase(db, "n1");
    expect(base("n1")).toBeUndefined();
    expect(getNoteBodies(db, ["n1"])[0].previousContent).toBeUndefined();
  });

  it("an own write discards only the baselines it created", () => {
    mk(db, "ext", "Ext", "a");
    mk(db, "own", "Own", "x");
    updateNote(db, "ext", { content: "b" });     // external, before the own write
    const before = noteChangeBaseHead(db);
    updateNote(db, "own", { content: "y" });     // the user's save
    discardNoteChangeBasesSince(db, before);
    expect(base("own")).toBeUndefined();
    expect(base("ext")?.previous_content).toBe("a");
  });

  it("prunes baselines for deleted notes and old ones", () => {
    mk(db, "gone", "Gone", "a");
    mk(db, "old", "Old", "a");
    mk(db, "fresh", "Fresh", "a");
    for (const id of ["gone", "old", "fresh"]) updateNote(db, id, { content: "b" });
    db.prepare("UPDATE notes SET deleted_at = ? WHERE id = 'gone'").run(new Date().toISOString());
    db.prepare("UPDATE note_change_base SET changed_at = '2000-01-01T00:00:00.000Z' WHERE note_id = 'old'").run();
    expect(pruneNoteChangeBases(db)).toBe(2);
    expect(base("fresh")?.previous_content).toBe("a");
  });
});
