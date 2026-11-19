import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { makeDb, seedProject, seedWorkspace } from "../test-support/db";
import { createNote, deleteNote, updateNote } from "./notes-queries";
import {
  addAttendee, addEdge, attendeeIdsFromSource, removeAttendee, removeMention, addMention, createMeeting, createPerson, getPerson, listAttendees, setNoteMeeting, updatePerson,
} from "./people-queries";
import { computeAutoRelationships } from "./auto-relationships";
import { indexNotePeople, indexNotesPeople } from "./people-indexing";
import { captureNoteMeeting, renderMeetingFrontmatter } from "./people-capture";
import { getKnowledgeGraph } from "./graph-queries";
import { actionItemLineKey, noteMeetingId } from "../../shared/people/ids";

let db: Database.Database;

beforeEach(() => {
  db = makeDb();
  seedWorkspace(db);
  seedProject(db);
});
afterEach(() => db.close());

const note = (id: string, title: string, content = "") =>
  createNote(db, { id, projectId: "proj1", workspaceId: "ws1", title, content });
const person = (name: string, extra: Partial<Parameters<typeof createPerson>[1]> = {}) =>
  createPerson(db, { workspaceId: "ws1", name, ...extra });
/** A person with a persona note titled after them. */
const persona = (name: string, noteId = `p-${name.split(" ")[0].toLowerCase()}`) => {
  note(noteId, name);
  const p = person(name);
  updatePerson(db, p.id, { personaNoteId: noteId });
  return p;
};
const save = (id: string, content: string) => {
  updateNote(db, id, { content });
  computeAutoRelationships(db, "ws1", [id]);
};
const mentions = (noteId: string) =>
  (db.prepare("SELECT person_id, source FROM note_mentions WHERE note_id = ? AND deleted_at IS NULL ORDER BY person_id")
    .all(noteId) as { person_id: string; source: string }[]);
const items = (noteId: string) =>
  db.prepare("SELECT line_key, owner_text, owner_person_id, text, done FROM note_action_items WHERE note_id = ? ORDER BY text")
    .all(noteId) as { line_key: string; owner_text: string | null; owner_person_id: string | null; text: string; done: number }[];
const snapshot = () => JSON.stringify([
  db.prepare("SELECT id, deleted_at, updated_at FROM note_mentions ORDER BY id").all(),
  db.prepare("SELECT * FROM note_action_items ORDER BY note_id, line_key").all(),
  db.prepare("SELECT id, deleted_at, updated_at, status FROM meeting_attendees ORDER BY id").all(),
  db.prepare("SELECT id, starts_at, updated_at, deleted_at FROM meetings ORDER BY id").all(),
  db.prepare("SELECT id, status, deleted_at, updated_at FROM people ORDER BY id").all(),
]);

describe("mention pass", () => {
  it("adds a wikilink mention for a persona note link, in every link form", () => {
    const ana = persona("Ana Ruiz");
    const ben = persona("Ben Ode");
    note("n1", "Sync");
    save("n1", "Talked to [[Ana Ruiz|Ana]] and [[People/ben ode#Notes]]. Also [[Unrelated]].");
    const byId = (a: { person_id: string }, b: { person_id: string }) => (a.person_id < b.person_id ? -1 : 1);
    expect(mentions("n1").sort(byId)).toEqual([
      { person_id: ana.id, source: "wikilink" },
      { person_id: ben.id, source: "wikilink" },
    ].sort(byId));
  });

  it("removes its own mentions when the link goes, and leaves manual mentions alone", () => {
    const ana = persona("Ana Ruiz");
    const ben = persona("Ben Ode");
    note("n1", "Sync");
    addMention(db, "n1", ben.id, "manual");
    save("n1", "[[Ana Ruiz]] and [[Ben Ode]]");
    expect(mentions("n1").map((m) => m.source)).toContain("manual");
    save("n1", "nobody");
    expect(mentions("n1")).toEqual([{ person_id: ben.id, source: "manual" }]);
    // Re-adding the link revives the same row.
    save("n1", "[[Ana Ruiz]]");
    expect(mentions("n1").map((m) => m.person_id)).toContain(ana.id);
  });

  it("ignores a persona note linking to itself and links to plain notes", () => {
    const ana = persona("Ana Ruiz", "pa");
    note("other", "Roadmap");
    save("pa", "See [[Ana Ruiz]] and [[Roadmap]]");
    expect(mentions("pa")).toEqual([]);
    expect(ana).toBeTruthy();
  });
});

describe("action item pass", () => {
  it("indexes owned checklist lines and resolves single matches only", () => {
    const ana = person("Ana Ruiz", { aliases: ["Ana"] });
    person("Chris");
    person("Chris");
    note("n1", "Minutes");
    save("n1", [
      "- [ ] **Ana** - send the deck",
      "- [x] [[Ana Ruiz]]: book the room",
      "- [ ] **Chris** - review",
      "- [ ] **Team** - retro",
      "- [ ] no owner here",
    ].join("\n"));
    const rows = items("n1");
    expect(rows.map((r) => [r.text, r.owner_text, r.owner_person_id, r.done])).toEqual([
      ["book the room", "Ana Ruiz", ana.id, 1],
      ["retro", "Team", null, 0],
      ["review", "Chris", null, 0],
      ["send the deck", "Ana", ana.id, 0],
    ]);
    // Owners never create stub people.
    expect(db.prepare("SELECT COUNT(*) c FROM people WHERE id LIKE 'stub:%'").get()).toEqual({ c: 0 });
  });

  it("keeps a line's key when it's ticked and gives duplicate lines their own rows", () => {
    note("n1", "Minutes");
    save("n1", "- [ ] **Ana** - send the deck\n- [ ] **Ana** - send the deck");
    const before = items("n1").map((r) => r.line_key);
    const base = actionItemLineKey("- [ ] **Ana** - send the deck");
    expect(before.sort()).toEqual([base, `${base}#2`].sort());
    save("n1", "- [x] **Ana** - send the deck");
    expect(items("n1")).toEqual([{ line_key: base, owner_text: "Ana", owner_person_id: null, text: "send the deck", done: 1 }]);
    save("n1", "");
    expect(items("n1")).toEqual([]);
  });
});

describe("body meeting line pass", () => {
  it("makes the note a meeting with body_line attendees, and removing the line removes them", () => {
    const ana = person("Ana Ruiz");
    note("n1", "Weekly sync");
    save("n1", "**Attendees:** Ana Ruiz, Dana Lee\n**When:** 2026-11-11\n\nNotes…");
    const meetingId = noteMeetingId("ws1", "n1");
    expect(listAttendees(db, meetingId).map((a) => [a.personId, a.source, a.provenance])).toEqual([[ana.id, "body_line", "convention"]]);
    const meeting = db.prepare("SELECT starts_at FROM meetings WHERE id = ?").get(meetingId) as { starts_at: string };
    expect(meeting.starts_at).toBe("2026-11-11T00:00:00.000Z");

    save("n1", "Notes…");
    expect(listAttendees(db, meetingId)).toEqual([]);
    expect(getPerson(db, ana.id)).not.toBeNull();
  });

  it("creates no stub people for unknown or half-typed names, and no meeting when nothing matches", () => {
    note("n1", "Sync");
    const writes = () => (db.prepare("SELECT (SELECT COUNT(*) FROM people) + (SELECT COUNT(*) FROM meetings) + (SELECT COUNT(*) FROM meeting_attendees) AS c").get() as { c: number }).c;
    const version = () => (db.prepare("SELECT version FROM notes WHERE id = 'n1'").get() as { version: number }).version;
    const before = { writes: writes(), version: version() };
    for (const typed of ["C", "Ch", "Chri", "Chris"]) save("n1", `**Attendees:** ${typed}`);
    expect(writes()).toBe(before.writes);
    expect(version()).toBe(before.version + 4); // only the four content saves themselves
    expect(db.prepare("SELECT meeting_id FROM notes WHERE id = 'n1'").get()).toEqual({ meeting_id: null });
    // Once the person exists, the same line matches them.
    const chris = person("Chris");
    save("n1", "**Attendees:** Chris");
    expect(attendeeIdsFromSource(db, noteMeetingId("ws1", "n1"), "body_line")).toEqual([chris.id]);
  });

  it("ignores placeholder and group names and unmarked prose labels", () => {
    note("n1", "Sync");
    person("Users");
    save("n1", "Participants: Users");
    save("n1", "**Attendees:** TBD, Users");
    expect(db.prepare("SELECT meeting_id FROM notes WHERE id = 'n1'").get()).toEqual({ meeting_id: null });
  });

  it("applies a body date only when no frontmatter date governs, and leaves an unchanged meeting untouched", () => {
    const ana = person("Ana Ruiz");
    note("n1", "Sync");
    const meetingId = noteMeetingId("ws1", "n1");
    const row = () => db.prepare("SELECT starts_at, updated_at FROM meetings WHERE id = ?").get(meetingId) as { starts_at: string; updated_at: string };
    save("n1", "**Attendees:** Ana Ruiz\n**When:** 2026-11-11");
    expect(row().starts_at).toBe("2026-11-11T00:00:00.000Z");
    const settled = row();
    save("n1", "**Attendees:** Ana Ruiz\n**When:** 2026-11-11\nmore");
    expect(row()).toEqual(settled);

    // The file's frontmatter lists attendees (and a date): it wins over the body.
    captureNoteMeeting(db, { noteId: "n1", attendees: ["Ana Ruiz"], date: "2026-12-01T00:00:00.000Z", source: "frontmatter", provenance: "explicit" });
    expect(row().starts_at).toBe("2026-12-01T00:00:00.000Z");
    const governed = row();
    save("n1", "**Attendees:** Ana Ruiz\n**When:** 2026-11-11\nthird save");
    expect(row()).toEqual(governed);
    expect(ana).toBeTruthy();
  });

  it("leaves attendees from other sources and a calendar meeting's time alone", () => {
    const ana = person("Ana Ruiz");
    const ben = person("Ben Ode");
    note("n1", "Sync");
    const cal = createMeeting(db, { workspaceId: "ws1", title: "Sync", startsAt: "2026-11-12T10:00:00.000Z", source: "calendar" });
    setNoteMeeting(db, "n1", cal.id);
    addAttendee(db, { meetingId: cal.id, personId: ben.id, source: "calendar", provenance: "explicit" });
    save("n1", "**Attendees:** Ana Ruiz\n**When:** 2026-11-11");
    expect(listAttendees(db, cal.id).map((a) => a.personId).sort()).toEqual([ana.id, ben.id].sort());
    save("n1", "");
    expect(listAttendees(db, cal.id).map((a) => a.personId)).toEqual([ben.id]);
    const m = db.prepare("SELECT starts_at FROM meetings WHERE id = ?").get(cal.id) as { starts_at: string };
    expect(m.starts_at).toBe("2026-11-12T10:00:00.000Z");
  });
});

describe("body_line claims", () => {
  it("finds a person's body_line claim by source (fails if sources is read as an array) and drops only that claim", () => {
    const ana = person("Ana Ruiz");
    note("n1", "Sync");
    save("n1", "**Attendees:** Ana Ruiz");
    const meetingId = noteMeetingId("ws1", "n1");
    expect(attendeeIdsFromSource(db, meetingId, "body_line")).toEqual([ana.id]);
    const row = db.prepare("SELECT sources FROM meeting_attendees WHERE meeting_id = ?").get(meetingId) as { sources: string };
    expect(JSON.parse(row.sources)).toMatchObject({ body_line: { on: true } });
    // Another source also lists her: removing the line keeps her attending.
    addAttendee(db, { meetingId, personId: ana.id, source: "manual", provenance: "explicit" });
    save("n1", "no lines");
    expect(attendeeIdsFromSource(db, meetingId, "body_line")).toEqual([]);
    expect(listAttendees(db, meetingId).map((a) => a.personId)).toEqual([ana.id]);
  });
});

describe("body-line attendees are suggestions", () => {
  it("adds matched people as suggested, keeps them out of the graph and frontmatter", () => {
    const ana = person("Ana Ruiz");
    note("n1", "Sync");
    save("n1", "**Attendees:** Ana Ruiz, Dana Lee");
    const meetingId = noteMeetingId("ws1", "n1");
    expect(listAttendees(db, meetingId).map((a) => a.status)).toEqual(["suggested"]);
    expect(renderMeetingFrontmatter(db, "n1")?.attendees).toEqual([]);
    const g = getKnowledgeGraph(db, "ws1");
    expect(g.edges.some((e) => e.type === "attended")).toBe(false);
    // An attendee someone else already confirmed stays confirmed.
    addAttendee(db, { meetingId, personId: ana.id, source: "manual" });
    save("n1", "**Attendees:** Ana Ruiz, Dana Lee\n");
    expect(listAttendees(db, meetingId).find((a) => a.personId === ana.id)?.status).toBe("confirmed");
  });

  it("doesn't bring back someone the user removed while the line still lists them", () => {
    const ana = person("Ana Ruiz");
    const ben = person("Ben Ode");
    note("n1", "Sync");
    save("n1", "**Attendees:** Ana Ruiz, Ben Ode");
    const meetingId = noteMeetingId("ws1", "n1");
    removeAttendee(db, meetingId, ana.id);
    save("n1", "**Attendees:** Ana Ruiz, Ben Ode\nmore text");
    expect(listAttendees(db, meetingId).map((a) => a.personId)).toEqual([ben.id]);
    // Once the line drops her, a later mention of her on the line is a fresh request.
    save("n1", "**Attendees:** Ben Ode");
    save("n1", "**Attendees:** Ana Ruiz, Ben Ode");
    expect(listAttendees(db, meetingId).map((a) => a.personId).sort()).toEqual([ana.id, ben.id].sort());
  });
});

describe("mention edge cases", () => {
  it("skips a persona title two people share", () => {
    persona("Ana Ruiz", "pa1");
    const twin = person("Ana Twin");
    note("pa2", "Ana Ruiz");
    updatePerson(db, twin.id, { personaNoteId: "pa2" });
    note("n1", "Sync");
    save("n1", "[[Ana Ruiz]]");
    expect(mentions("n1")).toEqual([]);
  });

  it("ignores links inside code", () => {
    persona("Ana Ruiz");
    note("n1", "Sync");
    save("n1", "`[[Ana Ruiz]]`\n```\n[[Ana Ruiz]]\n```\n~~~\n[[Ana Ruiz]]\n~~~");
    expect(mentions("n1")).toEqual([]);
  });

  it("doesn't revive a mention the user removed, but does when the link itself left and came back", () => {
    const ana = persona("Ana Ruiz");
    note("n1", "Sync");
    save("n1", "[[Ana Ruiz]]");
    removeMention(db, "n1", ana.id);
    save("n1", "[[Ana Ruiz]] still here");
    expect(mentions("n1")).toEqual([]);

    const ben = persona("Ben Ode");
    save("n1", "[[Ben Ode]]");
    expect(mentions("n1").map((m) => m.person_id)).toEqual([ben.id]);
    save("n1", "gone");
    expect(mentions("n1")).toEqual([]);
    save("n1", "[[Ben Ode]] back");
    expect(mentions("n1").map((m) => m.person_id)).toEqual([ben.id]);
  });
});

describe("ghost meetings", () => {
  it("tombstones a note-made meeting with its last note, but not a calendar meeting", () => {
    const ana = person("Ana Ruiz");
    note("n1", "Sync");
    save("n1", "**Attendees:** Ana Ruiz");
    const meetingId = noteMeetingId("ws1", "n1");
    const cal = createMeeting(db, { workspaceId: "ws1", title: "Cal", startsAt: "2026-11-12T10:00:00.000Z", source: "calendar" });
    note("n2", "Minutes");
    setNoteMeeting(db, "n2", cal.id);
    deleteNote(db, "n2");
    expect(db.prepare("SELECT deleted_at FROM meetings WHERE id = ?").get(cal.id)).toEqual({ deleted_at: null });
    deleteNote(db, "n1");
    expect(db.prepare("SELECT deleted_at IS NOT NULL AS gone FROM meetings WHERE id = ?").get(meetingId)).toEqual({ gone: 1 });
    expect(listAttendees(db, meetingId)).toEqual([]);
    expect(ana).toBeTruthy();
  });

  it("keeps a note-made meeting while another live note points at it", () => {
    person("Ana Ruiz");
    note("n1", "Sync");
    save("n1", "**Attendees:** Ana Ruiz");
    const meetingId = noteMeetingId("ws1", "n1");
    note("n2", "Prep");
    setNoteMeeting(db, "n2", meetingId);
    deleteNote(db, "n1");
    expect(db.prepare("SELECT deleted_at FROM meetings WHERE id = ?").get(meetingId)).toEqual({ deleted_at: null });
  });

  it("hides a note-made meeting with no confirmed attendee, but not calendar or confirmed ones", () => {
    const ana = person("Ana Ruiz");
    note("n1", "Sync");
    save("n1", "**Attendees:** Ana Ruiz"); // only a suggestion
    const meetingId = noteMeetingId("ws1", "n1");
    const cal = createMeeting(db, { workspaceId: "ws1", title: "Cal", startsAt: "2026-11-12T10:00:00.000Z", source: "calendar" });
    const ids = () => new Set(getKnowledgeGraph(db, "ws1").nodes.map((n) => n.id));
    expect(ids().has(meetingId)).toBe(false);
    expect(ids().has(cal.id)).toBe(true);
    expect(getKnowledgeGraph(db, "ws1", { projectIds: ["proj1"] }).nodes.some((n) => n.id === meetingId)).toBe(false);
    addAttendee(db, { meetingId, personId: ana.id, source: "manual" });
    expect(ids().has(meetingId)).toBe(true);
    expect(getKnowledgeGraph(db, "ws1", { projectIds: ["proj1"] }).nodes.some((n) => n.id === meetingId)).toBe(true);
  });

  it("leaves a meeting out of the graph when its only note is archived", () => {
    const ana = person("Ana Ruiz");
    note("n1", "Sync");
    save("n1", "**Attendees:** Ana Ruiz");
    const meetingId = noteMeetingId("ws1", "n1");
    addAttendee(db, { meetingId, personId: ana.id, source: "manual" });
    expect(getKnowledgeGraph(db, "ws1").nodes.some((n) => n.id === meetingId)).toBe(true);
    updateNote(db, "n1", { archivedAt: new Date().toISOString() });
    expect(getKnowledgeGraph(db, "ws1").nodes.some((n) => n.id === meetingId)).toBe(false);
  });
});

describe("resilience and entry points", () => {
  it("one failing note doesn't stop the rest of the batch", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const ana = person("Ana Ruiz");
    note("bad", "Bad", "- [ ] **Ana Ruiz** - boom\n**Attendees:** Ana Ruiz");
    note("good", "Good", "- [ ] **Ana Ruiz** - fine\n**Attendees:** Ana Ruiz");
    db.exec(`
      CREATE TRIGGER boom_items BEFORE INSERT ON note_action_items WHEN NEW.note_id = 'bad' BEGIN SELECT RAISE(ABORT, 'boom'); END;
      CREATE TRIGGER boom_meetings BEFORE INSERT ON meetings WHEN NEW.title = 'Bad' BEGIN SELECT RAISE(ABORT, 'boom'); END;
    `);
    expect(() => indexNotePeople(db, "ws1", ["bad", "good"])).not.toThrow();
    expect(items("good").map((r) => r.owner_person_id)).toEqual([ana.id]);
    expect(attendeeIdsFromSource(db, noteMeetingId("ws1", "good"), "body_line")).toEqual([ana.id]);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it("indexNotesPeople indexes changed notes by id", () => {
    const ana = persona("Ana Ruiz");
    note("n1", "One", "[[Ana Ruiz]]\n- [ ] **Ana Ruiz** - x");
    indexNotesPeople(db, ["n1", "missing"]);
    expect(mentions("n1").map((m) => m.person_id)).toEqual([ana.id]);
    expect(items("n1")).toHaveLength(1);
  });
});

describe("indexing as a whole", () => {
  const body = "**Attendees:** Ana Ruiz\n\nWith [[Ana Ruiz]].\n- [ ] **Ana Ruiz** - follow up";

  it("is idempotent, incrementally and in a full pass", () => {
    persona("Ana Ruiz");
    note("n1", "Sync");
    save("n1", body);
    const first = snapshot();
    save("n1", body);
    indexNotePeople(db, "ws1");
    computeAutoRelationships(db, "ws1");
    expect(snapshot()).toBe(first);
  });

  it("indexes every note on a full pass", () => {
    const ana = persona("Ana Ruiz");
    note("n1", "One", "[[Ana Ruiz]]");
    note("n2", "Two", "- [ ] **Ana Ruiz** - x");
    computeAutoRelationships(db, "ws1");
    expect(mentions("n1").map((m) => m.person_id)).toEqual([ana.id]);
    expect(items("n2").map((r) => r.owner_person_id)).toEqual([ana.id]);
  });
});

describe("knowledge graph people nodes", () => {
  function seed() {
    const ana = persona("Ana Ruiz", "pa");
    const ben = person("Ben Ode");
    const stub = person("Maybe", { status: "suggested" });
    note("n1", "Sync", "**Attendees:** Ana Ruiz, Ben Ode\n\nSee [[Ana Ruiz]]");
    computeAutoRelationships(db, "ws1", ["n1"]);
    // Body-line attendees are only suggested until the user confirms them.
    for (const p of [ana, ben]) addAttendee(db, { meetingId: noteMeetingId("ws1", "n1"), personId: p.id, source: "manual" });
    addEdge(db, { workspaceId: "ws1", sourceId: ben.id, targetId: ana.id, type: "manager_of" });
    addEdge(db, { workspaceId: "ws1", sourceId: ana.id, targetId: ben.id, type: "mentor_of", endedAt: "2026-01-01T00:00:00.000Z" });
    addEdge(db, { workspaceId: "ws1", sourceId: ana.id, targetId: ben.id, type: "buddy_of" });
    return { ana, ben, stub, meetingId: noteMeetingId("ws1", "n1") };
  }
  const edgeKeys = (g: ReturnType<typeof getKnowledgeGraph>, types: string[]) =>
    g.edges.filter((e) => types.includes(e.type)).map((e) => `${e.type} ${e.source} ${e.target} ${e.label}`).sort();

  it("emits confirmed people, meetings and their edges", () => {
    const { ana, ben, stub, meetingId } = seed();
    const g = getKnowledgeGraph(db, "ws1");
    const byId = new Map(g.nodes.map((n) => [n.id, n]));
    expect(byId.get(ana.id)).toMatchObject({ type: "person", title: "Ana Ruiz", meta: { personaNoteId: "pa" } });
    expect(byId.get(ben.id)?.type).toBe("person");
    expect(byId.has(stub.id)).toBe(false);
    expect(byId.get(meetingId)).toMatchObject({ type: "meeting", title: "Sync" });
    expect(edgeKeys(g, ["attended", "mentions", "meeting-note", "reports-to", "mentor", "partner", "stakeholder"])).toEqual([
      `attended ${ana.id} ${meetingId} attended`,
      `attended ${ben.id} ${meetingId} attended`,
      `meeting-note ${meetingId} n1 notes`,
      `mentions n1 ${ana.id} mentions`,
      `mentor ${ana.id} ${ben.id} mentor (former)`,
      `reports-to ${ana.id} ${ben.id} reports to`,
    ].sort());
  });

  it("honours node and edge type filters", () => {
    const { meetingId } = seed();
    const g = getKnowledgeGraph(db, "ws1", { nodeTypes: ["project", "note", "person"] });
    expect(g.nodes.some((n) => n.id === meetingId)).toBe(false);
    expect(g.edges.some((e) => e.type === "attended" || e.type === "meeting-note")).toBe(false);
    expect(g.edges.some((e) => e.type === "mentions")).toBe(true);
    const g2 = getKnowledgeGraph(db, "ws1", { edgeTypes: ["project-member"] });
    expect(g2.edges.every((e) => e.type === "project-member")).toBe(true);
  });

  it("scopes to a project: only meetings of its notes and the people linked to them", () => {
    const { ana, ben, meetingId } = seed();
    const loner = person("Loner");
    db.prepare("INSERT INTO projects (id, workspace_id, name, created_at, updated_at) VALUES ('proj2', 'ws1', 'Other', datetime('now'), datetime('now'))").run();
    const g = getKnowledgeGraph(db, "ws1", { projectIds: ["proj1"] });
    const ids = new Set(g.nodes.map((n) => n.id));
    expect(ids.has(meetingId) && ids.has(ana.id) && ids.has(ben.id)).toBe(true);
    expect(ids.has(loner.id)).toBe(false);
    const other = getKnowledgeGraph(db, "ws1", { projectIds: ["proj2"] });
    expect(other.nodes.some((n) => n.type === "person" || n.type === "meeting")).toBe(false);
  });

});
