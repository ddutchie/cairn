/** addNoteAttendee must not replace a note's calendar-meeting link with a fresh meeting while that meeting hasn't synced yet. */
import { describe, it, expect, vi, beforeEach } from "vitest";
import BetterSqlite3 from "../../../vitest-sqlite-shim.cjs";
import type Database from "better-sqlite3";
import { MOBILE_SCHEMA_SQL, MOBILE_TRIGGERS_SQL } from "./schema";

const h = vi.hoisted(() => ({ db: null as unknown as Database.Database }));
vi.mock("./index", () => ({
  getActiveSource: () => "ws1",
  getDb: () => ({ getAllSync: (sql: string, ...p: unknown[]) => h.db.prepare(sql).all(...p), getFirstSync: (sql: string, ...p: unknown[]) => h.db.prepare(sql).get(...p) ?? null }),
}));
vi.mock("./expo-sync-db", () => ({ createExpoSyncDb: () => h.db }));
vi.mock("@/sync/write-signal", () => ({ notifyLocalWrite: () => {} }));
vi.mock("./queries", () => ({ updateNote: () => {} }));

const { addNoteAttendee, setActionItemDone, loadOpenItems, saveProfile } = await import("./people");
const NOW = "2026-11-18T10:00:00.000Z";
const addNote = (id: string, content: string, extra = "") =>
  h.db.prepare(`INSERT INTO notes (id, project_id, workspace_id, title, content, created_at, updated_at${extra ? ", deleted_at" : ""}) VALUES (?, 'p1', 'ws1', 'Sync', ?, ?, ?${extra ? ", ?" : ""})`).run(...[id, content, NOW, NOW, ...(extra ? [extra] : [])]);

beforeEach(() => {
  h.db = new (BetterSqlite3 as unknown as new (f: string) => Database.Database)(":memory:");
  h.db.exec(MOBILE_SCHEMA_SQL);
  h.db.exec(MOBILE_TRIGGERS_SQL);
  const now = "2026-11-18T10:00:00.000Z";
  h.db.prepare("INSERT INTO workspaces (id, name, created_at, updated_at) VALUES ('ws1', 'W', ?, ?)").run(now, now);
  h.db.prepare("INSERT INTO people (id, workspace_id, name, aliases, emails, created_at, updated_at) VALUES ('ana', 'ws1', 'Ana Ruiz', '[]', '[]', ?, ?)").run(now, now);
});

describe("addNoteAttendee", () => {
  it("refuses, retryably, when the note's meeting row hasn't synced", () => {
    h.db.prepare("INSERT INTO notes (id, project_id, workspace_id, title, content, meeting_id, created_at, updated_at) VALUES ('n1', 'p1', 'ws1', 'Sync', 'x', 'cal:future', ?, ?)").run("2026-11-18T10:00:00.000Z", "2026-11-18T10:00:00.000Z");
    expect(() => addNoteAttendee("n1", "ana")).toThrow(/hasn't synced/);
    expect(h.db.prepare("SELECT meeting_id AS m FROM notes WHERE id='n1'").get()).toEqual({ m: "cal:future" });
  });

  it("a rejected add leaves the note unlinked", () => {
    addNote("n1", "x");
    expect(() => addNoteAttendee("n1", "nobody")).toThrow(/Person not found/);
    expect(h.db.prepare("SELECT meeting_id AS m FROM notes WHERE id='n1'").get()).toEqual({ m: null });
  });

  it("refuses a deleted note", () => {
    addNote("n1", "x", NOW);
    expect(() => addNoteAttendee("n1", "ana")).toThrow(/gone/);
  });

  it("gives a restored note whose meeting was deleted a fresh meeting", () => {
    addNote("n1", "x");
    h.db.prepare("INSERT INTO meetings (id, workspace_id, title, starts_at, source, created_at, updated_at, deleted_at) VALUES ('nmt:old', 'ws1', 'Sync', ?, 'note', ?, ?, ?)").run(NOW, NOW, NOW, NOW);
    h.db.prepare("UPDATE notes SET meeting_id = 'nmt:old' WHERE id = 'n1'").run();
    expect(addNoteAttendee("n1", "ana").personId).toBe("ana");
    expect((h.db.prepare("SELECT meeting_id AS m FROM notes WHERE id='n1'").get() as { m: string }).m).not.toBe("nmt:old");
  });
});

describe("open items", () => {
  it("skips templates and refuses a tick against a note body that changed since listing", () => {
    addNote("n1", "- [ ] **Ana Ruiz** - draft the plan\n");
    h.db.prepare("INSERT INTO notes (id, project_id, workspace_id, title, content, type, created_at, updated_at) VALUES ('t1', 'p1', 'ws1', 'Tpl', '- [ ] **Ana Ruiz** - template task', 'template', ?, ?)").run(NOW, NOW);
    const ana = { id: "ana", workspaceId: "ws1", personaNoteId: null } as never;
    const items = loadOpenItems(ana).theyOwe;
    expect(items.map((i) => i.noteId)).toEqual(["n1"]);
    h.db.prepare("UPDATE notes SET content = ? WHERE id = 'n1'").run("- [ ] **Ana Ruiz** - something else\n- [ ] **Ana Ruiz** - draft the plan\n");
    expect(setActionItemDone("n1", items[0].lineKey, true, items[0].bodyDigest)).toBe(false);
    const fresh = loadOpenItems(ana).theyOwe;
    expect(setActionItemDone("n1", fresh[0].lineKey, true, fresh[0].bodyDigest)).toBe(true);
  });
});

describe("saveProfile", () => {
  const edit = { title: "Senior Engineer", team: "Sync", location: "Berlin", timezone: "Europe/Berlin", slackId: "U01ABC" };
  it("stores the fields and clears a blank one", () => {
    saveProfile("ana", edit);
    expect(h.db.prepare("SELECT title, team, location, timezone, slack_id AS s FROM people WHERE id='ana'").get())
      .toEqual({ title: "Senior Engineer", team: "Sync", location: "Berlin", timezone: "Europe/Berlin", s: "U01ABC" });
    saveProfile("ana", { team: "  " });
    expect(h.db.prepare("SELECT title, team FROM people WHERE id='ana'").get()).toEqual({ title: "Senior Engineer", team: null });
  });
});
