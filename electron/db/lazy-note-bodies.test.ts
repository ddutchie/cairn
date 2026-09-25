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
