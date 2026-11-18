import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { makeDb, seedProject, seedWorkspace } from "../test-support/db";
import { applySchemaThrough, applySchema } from "./schema";
import BetterSqlite3 from "better-sqlite3";
import {
  addAttendee, addEdge, addMention, createMeeting, createPerson, deleteMeeting, deletePerson, edgeRole, getMe,
  getPerson, getRelations, isPeopleEnabled, listAttendees, listMeetingNoteIds, listOwnedCardIds, listPeople,
  listPersonMeetings, listPersonMentionNoteIds, listRelated, removeEdge, setCardOwner, setNoteMeeting,
  setPeopleEnabled, updatePerson, upsertMeetingByExternalId,
} from "./people-queries";
import { createNote } from "./notes-queries";
import { PEOPLE_SYNC_TABLES } from "../../shared/sync/people-schema";
import { SYNCABLE_TABLES } from "../../shared/sync/schema";

let db: Database.Database;

beforeEach(() => {
  db = makeDb();
  seedWorkspace(db);
  seedProject(db);
});
afterEach(() => db.close());

const person = (name: string, extra: Partial<Parameters<typeof createPerson>[1]> = {}) =>
  createPerson(db, { workspaceId: "ws1", name, ...extra });

function seedCard(id: string) {
  const col = db.prepare("SELECT id FROM board_columns WHERE project_id = 'proj1' LIMIT 1").get() as { id: string } | undefined;
  const columnId = col?.id ?? "col1";
  if (!col) {
    db.prepare(`INSERT INTO board_columns (id, project_id, workspace_id, name, type, "order", created_at, updated_at)
      VALUES ('col1', 'proj1', 'ws1', 'Backlog', 'backlog', 0, 'x', 'x')`).run();
  }
  db.prepare(`INSERT INTO task_cards (id, column_id, project_id, workspace_id, title, created_at, updated_at)
    VALUES (?, ?, 'proj1', 'ws1', 'Card', 'x', 'x')`).run(id, columnId);
}

describe("schema", () => {
  it("registers every people table for sync, with capture triggers", () => {
    for (const t of PEOPLE_SYNC_TABLES) {
      expect(SYNCABLE_TABLES).toContain(t);
      const triggers = db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ?").all(t);
      expect(triggers).toHaveLength(3);
    }
  });

  it("stages a person write in sync_pending", () => {
    const p = person("Chris Sponagle");
    const pending = db.prepare("SELECT op FROM sync_pending WHERE entity = 'people' AND entity_id = ?").all(p.id);
    expect(pending).toEqual([{ op: "put" }]);
  });

  it("upgrades a v65 database and keeps existing rows", () => {
    const old = new BetterSqlite3(":memory:");
    applySchemaThrough(old, 65);
    expect(old.prepare("SELECT name FROM sqlite_master WHERE name = 'people'").get()).toBeUndefined();
    applySchema(old);
    const noteCols = (old.prepare("PRAGMA table_info(notes)").all() as { name: string }[]).map((c) => c.name);
    const cardCols = (old.prepare("PRAGMA table_info(task_cards)").all() as { name: string }[]).map((c) => c.name);
    expect(noteCols).toContain("meeting_id");
    expect(cardCols).toContain("owner_person_id");
    for (const t of [...PEOPLE_SYNC_TABLES, "person_profile_cache", "note_action_items"]) {
      expect(old.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(t)).toBeTruthy();
    }
    old.close();
  });
});

describe("feature flag", () => {
  it("is off by default and can be toggled", () => {
    expect(isPeopleEnabled(db)).toBe(false);
    setPeopleEnabled(db, true);
    expect(isPeopleEnabled(db)).toBe(true);
    setPeopleEnabled(db, false);
    expect(isPeopleEnabled(db)).toBe(false);
  });
});

describe("people", () => {
  it("creates a person with multi-valued relationships and normalised identity fields", () => {
    const p = person("Sebastien Morel", {
      aliases: ["Seb", "seb", " "],
      emails: ["Seb@Example.com"],
      relationship: [
        { type: "stakeholder", provenance: "convention" },
        { type: "mentor", label: "mentor for years", provenance: "explicit" },
        { type: "stakeholder", provenance: "inferred" },
      ],
    });
    expect(p.aliases).toEqual(["Seb"]);
    expect(p.emails).toEqual(["seb@example.com"]);
    expect(p.relationship.map((r) => r.type)).toEqual(["stakeholder", "mentor"]);
    expect(p.status).toBe("confirmed");
    expect(p.isMe).toBe(false);
  });

  it("rejects unknown relationship types and empty names", () => {
    expect(() => person("X", { relationship: [{ type: "boss" as never, provenance: "explicit" }] })).toThrow(/relationship type/);
    expect(() => person("  ")).toThrow(/name/);
  });

  it("lists by relationship and status", () => {
    person("Chris", { relationship: [{ type: "direct_report", provenance: "explicit" }] });
    person("Anthony", { relationship: [{ type: "direct_report", provenance: "explicit" }] });
    person("Liron", { relationship: [{ type: "stakeholder", provenance: "convention" }] });
    person("Ryan", { status: "suggested", relationship: [{ type: "stakeholder", provenance: "inferred" }] });

    expect(listPeople(db, "ws1", { relationship: "direct_report" }).map((p) => p.name)).toEqual(["Anthony", "Chris"]);
    expect(listPeople(db, "ws1", { relationship: "stakeholder" }).map((p) => p.name)).toEqual(["Liron"]);
    expect(listPeople(db, "ws1", { statuses: ["suggested"] }).map((p) => p.name)).toEqual(["Ryan"]);
  });

  it("keeps a single is_me person per workspace", () => {
    const a = person("Gerard", { isMe: true });
    const b = person("Other");
    updatePerson(db, b.id, { isMe: true });
    expect(getPerson(db, a.id)!.isMe).toBe(false);
    expect(getMe(db, "ws1")!.id).toBe(b.id);
  });

  it("updates and clears optional fields", () => {
    const p = person("Elisa", { cadence: "weekly", slackId: "U123" });
    const u = updatePerson(db, p.id, { cadence: null, slackId: null, agentPrivate: true, status: "suggested" });
    expect(u.cadence).toBeUndefined();
    expect(u.slackId).toBeUndefined();
    expect(u.agentPrivate).toBe(true);
    expect(u.status).toBe("suggested");
  });

  it("deleting a person tombstones their links and clears card owners", () => {
    const a = person("Chris");
    const b = person("Gerard", { isMe: true });
    addEdge(db, { workspaceId: "ws1", sourceId: b.id, targetId: a.id, type: "manager_of" });
    const m = createMeeting(db, { workspaceId: "ws1", title: "1:1", startsAt: "2026-11-18T10:00:00Z" });
    addAttendee(db, { meetingId: m.id, personId: a.id });
    seedCard("c1");
    setCardOwner(db, "c1", a.id);

    deletePerson(db, a.id);
    expect(getPerson(db, a.id)).toBeNull();
    expect(getRelations(db, b.id)).toEqual([]);
    expect(listAttendees(db, m.id)).toEqual([]);
    expect(listOwnedCardIds(db, a.id)).toEqual([]);
    // Tombstoned, not removed: the rows stay for sync.
    expect(db.prepare("SELECT deleted_at FROM people WHERE id = ?").get(a.id)).toMatchObject({ deleted_at: expect.any(String) });
  });
});

describe("edges", () => {
  it("derives the inverse role", () => {
    const gerard = person("Gerard", { isMe: true });
    const chris = person("Chris");
    const elisa = person("Elisa");
    addEdge(db, { workspaceId: "ws1", sourceId: gerard.id, targetId: chris.id, type: "manager_of" });
    addEdge(db, { workspaceId: "ws1", sourceId: elisa.id, targetId: gerard.id, type: "manager_of" });

    expect(listRelated(db, gerard.id, "manager_of").map((p) => p.name)).toEqual(["Chris"]);
    expect(listRelated(db, gerard.id, "reports_to").map((p) => p.name)).toEqual(["Elisa"]);
    expect(listRelated(db, chris.id, "reports_to").map((p) => p.name)).toEqual(["Gerard"]);
  });

  it("is idempotent, and partner edges match in either direction", () => {
    const a = person("Anthony");
    const b = person("Marco");
    const e1 = addEdge(db, { workspaceId: "ws1", sourceId: a.id, targetId: b.id, type: "partner", label: "trifecta" });
    const e2 = addEdge(db, { workspaceId: "ws1", sourceId: b.id, targetId: a.id, type: "partner" });
    expect(e2.id).toBe(e1.id);
    expect(getRelations(db, b.id)[0]).toMatchObject({ role: "partner", otherId: a.id });
    const again = addEdge(db, { workspaceId: "ws1", sourceId: a.id, targetId: b.id, type: "partner", endedAt: "2026-01-01" });
    expect(again).toMatchObject({ id: e1.id, label: "trifecta", endedAt: "2026-01-01" });
  });

  it("keeps former relationships unless asked to drop them, and hides suggestions by default", () => {
    const me = person("Gerard", { isMe: true });
    const seb = person("Sebastien");
    const ryan = person("Ryan");
    addEdge(db, { workspaceId: "ws1", sourceId: seb.id, targetId: me.id, type: "mentor_of", endedAt: "2025-06-01" });
    addEdge(db, { workspaceId: "ws1", sourceId: ryan.id, targetId: me.id, type: "stakeholder_of", status: "suggested", provenance: "inferred" });

    expect(getRelations(db, me.id).map((r) => r.role)).toEqual(["mentee_of"]);
    expect(getRelations(db, me.id, { includeEnded: false })).toEqual([]);
    expect(getRelations(db, me.id, { statuses: ["confirmed", "suggested"] }).map((r) => r.role)).toEqual(["mentee_of", "has_stakeholder"]);
  });

  it("rejects self-edges and unknown people, and removes edges", () => {
    const a = person("A");
    expect(() => addEdge(db, { workspaceId: "ws1", sourceId: a.id, targetId: a.id, type: "manager_of" })).toThrow(/themself/);
    expect(() => addEdge(db, { workspaceId: "ws1", sourceId: a.id, targetId: "nope", type: "manager_of" })).toThrow(/not found/);
    const b = person("B");
    const e = addEdge(db, { workspaceId: "ws1", sourceId: a.id, targetId: b.id, type: "buddy_of" });
    removeEdge(db, e.id);
    expect(getRelations(db, a.id)).toEqual([]);
  });

  it("names each role from either side", () => {
    expect(edgeRole({ type: "stakeholder_of", sourceId: "x" }, "y")).toBe("has_stakeholder");
    expect(edgeRole({ type: "buddy_of", sourceId: "x" }, "x")).toBe("buddy_of");
  });
});

describe("meetings", () => {
  it("puts a combined meeting on every attendee's timeline", () => {
    const chris = person("Chris");
    const seb = person("Sebastien");
    const me = person("Gerard", { isMe: true });
    const m = createMeeting(db, { workspaceId: "ws1", title: "Weekly sync with Chris and Sebastien", startsAt: "2026-11-11T15:00:00Z" });
    for (const p of [chris, seb, me]) addAttendee(db, { meetingId: m.id, personId: p.id, source: "frontmatter" });

    for (const p of [chris, seb, me]) expect(listPersonMeetings(db, p.id).map((x) => x.id)).toEqual([m.id]);
  });

  it("lists a person's meetings newest first and skips suggested attendance", () => {
    const chris = person("Chris");
    const older = createMeeting(db, { workspaceId: "ws1", title: "Intro", startsAt: "2026-11-01T10:00:00Z" });
    const newer = createMeeting(db, { workspaceId: "ws1", title: "1:1", startsAt: "2026-11-18T10:00:00Z" });
    const maybe = createMeeting(db, { workspaceId: "ws1", title: "Maybe", startsAt: "2026-11-19T10:00:00Z" });
    addAttendee(db, { meetingId: older.id, personId: chris.id });
    addAttendee(db, { meetingId: newer.id, personId: chris.id });
    addAttendee(db, { meetingId: maybe.id, personId: chris.id, status: "suggested" });
    expect(listPersonMeetings(db, chris.id).map((m) => m.title)).toEqual(["1:1", "Intro"]);
  });

  it("adds an attendee once and confirms a suggestion on re-add", () => {
    const p = person("Sebastian");
    const m = createMeeting(db, { workspaceId: "ws1", title: "Sync", startsAt: "2026-11-11T15:00:00Z" });
    const a1 = addAttendee(db, { meetingId: m.id, personId: p.id, status: "suggested" });
    const a2 = addAttendee(db, { meetingId: m.id, personId: p.id });
    expect(a2.id).toBe(a1.id);
    expect(a2.status).toBe("confirmed");
    expect(listAttendees(db, m.id)).toHaveLength(1);
  });

  it("upserts calendar meetings by external id", () => {
    const a = upsertMeetingByExternalId(db, { workspaceId: "ws1", title: "1:1", startsAt: "2026-11-18T10:00:00Z", externalId: "evt-1", seriesKey: "s1" });
    const b = upsertMeetingByExternalId(db, { workspaceId: "ws1", title: "1:1 (moved)", startsAt: "2026-11-18T11:00:00Z", externalId: "evt-1" });
    expect(b.id).toBe(a.id);
    expect(b).toMatchObject({ title: "1:1 (moved)", startsAt: "2026-11-18T11:00:00Z", source: "calendar", seriesKey: "s1" });
  });

  it("links notes to a meeting and unlinks them when the meeting is deleted", () => {
    const note = createNote(db, { id: "n1", projectId: "proj1", workspaceId: "ws1", title: "Minutes" });
    const m = createMeeting(db, { workspaceId: "ws1", title: "Sync", startsAt: "2026-11-11T15:00:00Z", source: "note" });
    setNoteMeeting(db, note.id, m.id);
    expect(listMeetingNoteIds(db, m.id)).toEqual(["n1"]);
    deleteMeeting(db, m.id);
    expect(db.prepare("SELECT meeting_id FROM notes WHERE id = 'n1'").get()).toEqual({ meeting_id: null });
    expect(() => setNoteMeeting(db, "missing", null)).toThrow(/Note not found/);
  });
});

describe("mentions and card owners", () => {
  it("records a mention once per note", () => {
    const p = person("Ryan");
    createNote(db, { id: "n1", projectId: "proj1", workspaceId: "ws1", title: "Notes" });
    const m1 = addMention(db, "n1", p.id, "wikilink");
    const m2 = addMention(db, "n1", p.id, "owner");
    expect(m2.id).toBe(m1.id);
    expect(listPersonMentionNoteIds(db, p.id)).toEqual(["n1"]);
  });

  it("sets and clears a card owner", () => {
    const p = person("Chris");
    seedCard("c1");
    setCardOwner(db, "c1", p.id);
    expect(listOwnedCardIds(db, p.id)).toEqual(["c1"]);
    setCardOwner(db, "c1", null);
    expect(listOwnedCardIds(db, p.id)).toEqual([]);
    expect(() => setCardOwner(db, "c1", "nobody")).toThrow(/Person not found/);
  });
});
