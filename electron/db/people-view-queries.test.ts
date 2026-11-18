import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { makeDb, seedProject, seedWorkspace } from "../test-support/db";
import {
  addAttendee, addEdge, addMention, createMeeting, createPerson, deletePerson, setCardOwner, setNoteMeeting, updateEdge,
} from "./people-queries";
import { getPersonPage, getPersonTimeline, listPersonSummaries, listRelationViews } from "./people-view-queries";
import { createNote } from "./notes-queries";

let db: Database.Database;

beforeEach(() => {
  db = makeDb();
  seedWorkspace(db);
  seedProject(db);
});
afterEach(() => db.close());

const person = (name: string, extra: Partial<Parameters<typeof createPerson>[1]> = {}) =>
  createPerson(db, { workspaceId: "ws1", name, ...extra });

const meeting = (title: string, startsAt: string, ...people: string[]) => {
  const m = createMeeting(db, { workspaceId: "ws1", title, startsAt });
  for (const p of people) addAttendee(db, { meetingId: m.id, personId: p });
  return m;
};

function seedCard(id: string, columnType = "todo") {
  const colId = `col-${columnType}`;
  db.prepare(`INSERT OR IGNORE INTO board_columns (id, project_id, workspace_id, name, type, "order", created_at, updated_at)
    VALUES (?, 'proj1', 'ws1', ?, ?, 0, 'x', 'x')`).run(colId, columnType === "done" ? "Done" : "To do", columnType);
  db.prepare(`INSERT INTO task_cards (id, column_id, project_id, workspace_id, title, created_at, updated_at)
    VALUES (?, ?, 'proj1', 'ws1', ?, 'x', 'x')`).run(id, colId, `Card ${id}`);
}

const NOW = "2026-11-18T12:00:00.000Z";

describe("listPersonSummaries", () => {
  it("adds last and next confirmed meeting dates", () => {
    const a = person("Ada");
    const b = person("Bo");
    meeting("Old 1:1", "2026-10-01T10:00:00.000Z", a.id);
    meeting("Last 1:1", "2026-11-10T10:00:00.000Z", a.id);
    meeting("Next 1:1", "2026-11-25T10:00:00.000Z", a.id);
    const suggested = createMeeting(db, { workspaceId: "ws1", title: "Maybe", startsAt: "2026-11-17T10:00:00.000Z" });
    addAttendee(db, { meetingId: suggested.id, personId: a.id, status: "suggested" });

    const list = listPersonSummaries(db, "ws1", {}, NOW);
    const ada = list.find((p) => p.id === a.id)!;
    expect(ada.lastMetAt).toBe("2026-11-10T10:00:00.000Z");
    expect(ada.nextMeetingAt).toBe("2026-11-25T10:00:00.000Z");
    const bo = list.find((p) => p.id === b.id)!;
    expect(bo.lastMetAt).toBeUndefined();
    expect(bo.nextMeetingAt).toBeUndefined();
  });

  it("honours the status filter", () => {
    person("Confirmed");
    person("Proposed", { status: "suggested" });
    expect(listPersonSummaries(db, "ws1", {}, NOW).map((p) => p.name)).toEqual(["Confirmed"]);
    expect(listPersonSummaries(db, "ws1", { statuses: ["suggested"] }, NOW).map((p) => p.name)).toEqual(["Proposed"]);
  });
});

describe("listRelationViews", () => {
  it("names the other person and derives inverse roles", () => {
    const elisa = person("Elisa");
    const chris = person("Chris");
    const seb = person("Sebastien");
    addEdge(db, { workspaceId: "ws1", sourceId: elisa.id, targetId: chris.id, type: "manager_of" });
    const mentor = addEdge(db, { workspaceId: "ws1", sourceId: seb.id, targetId: chris.id, type: "mentor_of" });
    updateEdge(db, mentor.id, { endedAt: "2026-01-01" });

    const views = listRelationViews(db, chris.id);
    expect(views.map((v) => [v.role, v.otherName, v.edge.endedAt ?? null])).toEqual([
      ["reports_to", "Elisa", null],
      ["mentee_of", "Sebastien", "2026-01-01"],
    ]);
  });

  it("drops edges to deleted people", () => {
    const a = person("A");
    const b = person("B");
    addEdge(db, { workspaceId: "ws1", sourceId: a.id, targetId: b.id, type: "partner" });
    deletePerson(db, b.id);
    expect(listRelationViews(db, a.id)).toEqual([]);
  });
});

describe("getPersonTimeline", () => {
  it("merges meetings, mentions and owned cards newest first", () => {
    const chris = person("Chris");
    const seb = person("Sebastien");
    const m1 = meeting("Weekly sync", "2026-11-11T10:00:00.000Z", chris.id, seb.id);
    meeting("Kickoff", "2026-09-01T10:00:00.000Z", chris.id);
    createNote(db, { id: "minutes", projectId: "proj1", workspaceId: "ws1", title: "Sync minutes" });
    setNoteMeeting(db, "minutes", m1.id);
    createNote(db, { id: "mention", projectId: "proj1", workspaceId: "ws1", title: "Roadmap" });
    db.prepare("UPDATE notes SET updated_at = '2026-11-15T09:00:00.000Z' WHERE id = 'mention'").run();
    addMention(db, "mention", chris.id, "wikilink");
    seedCard("c1");
    setCardOwner(db, "c1", chris.id);
    db.prepare("UPDATE task_cards SET updated_at = '2026-10-01T00:00:00.000Z' WHERE id = 'c1'").run();

    const items = getPersonTimeline(db, chris.id);
    expect(items.map((i) => i.kind)).toEqual(["mention", "meeting", "card", "meeting"]);
    const sync = items[1];
    if (sync.kind !== "meeting") throw new Error("expected meeting");
    expect(sync.notes.map((n) => n.title)).toEqual(["Sync minutes"]);
    expect(sync.with).toEqual([{ personId: seb.id, name: "Sebastien" }]);
    const card = items[2];
    if (card.kind !== "card") throw new Error("expected card");
    expect(card.card).toMatchObject({ id: "c1", columnName: "To do", done: false });
  });

  it("leaves the persona note out of mentions", () => {
    createNote(db, { id: "persona", projectId: "proj1", workspaceId: "ws1", title: "Chris" });
    const chris = person("Chris", { personaNoteId: "persona" });
    addMention(db, "persona", chris.id, "wikilink");
    expect(getPersonTimeline(db, chris.id)).toEqual([]);
  });

  it("is empty for a deleted person", () => {
    const p = person("Gone");
    deletePerson(db, p.id);
    expect(getPersonTimeline(db, p.id)).toEqual([]);
  });
});

describe("getPersonPage", () => {
  it("returns the person, persona note and dates", () => {
    createNote(db, { id: "persona", projectId: "proj1", workspaceId: "ws1", title: "Chris", content: "# Chris\n\nLikes maps." });
    const chris = person("Chris", { personaNoteId: "persona" });
    meeting("1:1", "2026-11-10T10:00:00.000Z", chris.id);
    const page = getPersonPage(db, chris.id, NOW)!;
    expect(page.person.name).toBe("Chris");
    expect(page.persona).toMatchObject({ id: "persona", title: "Chris", projectId: "proj1" });
    expect(page.persona!.content).toContain("Likes maps.");
    expect(page.lastMetAt).toBe("2026-11-10T10:00:00.000Z");
    expect(page.timeline).toHaveLength(1);
  });

  it("returns null for an unknown person and no persona for a deleted note", () => {
    expect(getPersonPage(db, "nope")).toBeNull();
    const p = person("No persona", { personaNoteId: "missing" });
    expect(getPersonPage(db, p.id)!.persona).toBeNull();
  });
});
