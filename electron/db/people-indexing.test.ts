import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { makeDb, seedProject, seedWorkspace } from "../test-support/db";
import { createNote, updateNote } from "./notes-queries";
import {
  addAttendee, addEdge, attendeeIdsFromSource, removeAttendee, removeMention, addMention, createMeeting, createPerson, getPerson, listAttendees, setNoteMeeting, setPeopleEnabled, updatePerson,
} from "./people-queries";
import { computeAutoRelationships } from "./auto-relationships";
import { indexNotePeople, indexNotesPeople } from "./people-indexing";
import { renderMeetingFrontmatter } from "./people-capture";
import { getKnowledgeGraph } from "./graph-queries";
import { actionItemLineKey, noteMeetingId, stubPersonId } from "../../shared/people/ids";

let db: Database.Database;

beforeEach(() => {
  db = makeDb();
  seedWorkspace(db);
  seedProject(db);
  setPeopleEnabled(db, true);
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
    const att = listAttendees(db, meetingId);
    const dana = stubPersonId("ws1", "dana lee");
    expect(att.map((a) => [a.personId, a.source, a.provenance]).sort()).toEqual(
      [[ana.id, "body_line", "convention"], [dana, "body_line", "convention"]].sort(),
    );
    const meeting = db.prepare("SELECT starts_at FROM meetings WHERE id = ?").get(meetingId) as { starts_at: string };
    expect(meeting.starts_at).toBe("2026-11-11T00:00:00.000Z");

    save("n1", "Notes…");
    expect(listAttendees(db, meetingId)).toEqual([]);
    // The stub only that line created goes again; the real person stays.
    expect(getPerson(db, dana)).toBeNull();
    expect(getPerson(db, ana.id)).not.toBeNull();
  });

  it("drops the stubs a half-typed name made", () => {
    note("n1", "Sync");
    save("n1", "**Attendees:** Ch");
    save("n1", "**Attendees:** Chris Doe");
    expect(getPerson(db, stubPersonId("ws1", "ch"))).toBeNull();
    expect(getPerson(db, stubPersonId("ws1", "chris doe"))?.status).toBe("suggested");
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
  it("adds matched people and new stubs as suggested, keeps them out of the graph and frontmatter", () => {
    const ana = person("Ana Ruiz");
    note("n1", "Sync");
    save("n1", "**Attendees:** Ana Ruiz, Dana Lee");
    const meetingId = noteMeetingId("ws1", "n1");
    expect(listAttendees(db, meetingId).map((a) => a.status)).toEqual(["suggested", "suggested"]);
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

  it("doesn't re-create a dismissed stub's attendance", () => {
    note("n1", "Sync");
    save("n1", "**Attendees:** Dana Lee");
    const meetingId = noteMeetingId("ws1", "n1");
    const dana = stubPersonId("ws1", "dana lee");
    removeAttendee(db, meetingId, dana);
    save("n1", "**Attendees:** Dana Lee\nagain");
    expect(listAttendees(db, meetingId)).toEqual([]);
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

  it("indexNotesPeople indexes changed notes by id, and does nothing with the flag off", () => {
    const ana = persona("Ana Ruiz");
    note("n1", "One", "[[Ana Ruiz]]\n- [ ] **Ana Ruiz** - x");
    setPeopleEnabled(db, false);
    indexNotesPeople(db, ["n1"]);
    expect(mentions("n1")).toEqual([]);
    setPeopleEnabled(db, true);
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

  it("does nothing while the flag is off", () => {
    persona("Ana Ruiz");
    setPeopleEnabled(db, false);
    note("n1", "Sync");
    const before = snapshot();
    save("n1", body);
    computeAutoRelationships(db, "ws1");
    expect(snapshot()).toBe(before);
    expect(db.prepare("SELECT meeting_id FROM notes WHERE id = 'n1'").get()).toEqual({ meeting_id: null });
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

  it("adds nothing while the flag is off", () => {
    seed();
    setPeopleEnabled(db, false);
    const g = getKnowledgeGraph(db, "ws1");
    expect(g.nodes.some((n) => n.type === "person" || n.type === "meeting")).toBe(false);
  });
});
