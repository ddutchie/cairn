import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { makeDb, seedProject, seedWorkspace } from "../test-support/db";
import { createNote, deleteNote, updateNote } from "./notes-queries";
import {
  addAttendee, addMention, createMeeting, createPerson, getMe, getPerson, listAttendees, setNoteMeeting, setPeopleEnabled, updatePerson,
} from "./people-queries";
import { captureNoteMeeting, notesAffectedBy, pinUnreferenced, renderMeetingFrontmatter, resolvePerson } from "./people-capture";
import { noteMeetingId, stubPersonId } from "../../shared/people/ids";
import { deleteProject, mergeProject } from "./workspace-queries";

let db: Database.Database;

beforeEach(() => {
  db = makeDb();
  seedWorkspace(db);
  seedProject(db);
});
afterEach(() => db.close());

const person = (name: string, extra: Partial<Parameters<typeof createPerson>[1]> = {}) =>
  createPerson(db, { workspaceId: "ws1", name, ...extra });
const note = (id: string, title = "Weekly sync") =>
  createNote(db, { id, projectId: "proj1", workspaceId: "ws1", title, content: "" });
const attending = (meetingId: string) =>
  listAttendees(db, meetingId).map((a) => ({ personId: a.personId, status: a.status, source: a.source }));

describe("resolvePerson", () => {
  it("matches by email before name, and by alias or persona title", () => {
    const chris = person("Chris Sponagle", { emails: ["chris@acme.io"], aliases: ["CS"] });
    const persona = note("persona", "Chris S.");
    updatePerson(db, chris.id, { personaNoteId: persona.id });
    expect(resolvePerson(db, "ws1", { email: "CHRIS@acme.io", name: "Someone Else" })).toEqual({ kind: "match", personId: chris.id });
    expect(resolvePerson(db, "ws1", { name: "cs" })).toEqual({ kind: "match", personId: chris.id });
    expect(resolvePerson(db, "ws1", { name: "Chris S." })).toEqual({ kind: "match", personId: chris.id });
    expect(resolvePerson(db, "ws1", { name: "Nobody" })).toEqual({ kind: "none" });
  });

  it("reports two people with the same name as ambiguous", () => {
    const a = person("Chris", { aliases: [] });
    const b = person("Chris");
    const r = resolvePerson(db, "ws1", { name: "chris" });
    expect(r.kind).toBe("ambiguous");
    expect(r.kind === "ambiguous" && [...r.personIds].sort()).toEqual([a.id, b.id].sort());
  });

  it("skips a name the user dismissed", () => {
    person("Pat", { status: "dismissed" });
    expect(resolvePerson(db, "ws1", { name: "Pat" }).kind).toBe("dismissed");
  });
});

describe("captureNoteMeeting", () => {
  it("makes the note a meeting with a deterministic id and adds matched people", () => {
    const n = note("n1");
    const ana = person("Ana Ruiz");
    const r = captureNoteMeeting(db, { noteId: n.id, attendees: ["[[Ana Ruiz]]"], date: "2026-11-10T09:00:00.000Z", source: "frontmatter", provenance: "explicit" });
    expect(r.meetingId).toBe(noteMeetingId("ws1", n.id));
    expect(r.attendees).toEqual([ana.id]);
    const row = db.prepare("SELECT meeting_id FROM notes WHERE id = 'n1'").get() as { meeting_id: string };
    expect(row.meeting_id).toBe(r.meetingId);
    expect(attending(r.meetingId)).toEqual([{ personId: ana.id, status: "confirmed", source: "frontmatter" }]);
  });

  it("turns an ambiguous name into suggestions and an unknown one into a stub", () => {
    note("n1");
    const c1 = person("Chris");
    const c2 = person("Chris");
    const r = captureNoteMeeting(db, { noteId: "n1", attendees: ["Chris", "Dana Lee <dana@x.io>"], source: "frontmatter", provenance: "explicit" });
    expect([...r.suggested].sort()).toEqual([c1.id, c2.id].sort());
    expect(r.created).toHaveLength(1);
    const stub = getPerson(db, r.created[0])!;
    expect(stub.id).toBe(stubPersonId("ws1", "dana@x.io"));
    expect(stub.name).toBe("Dana Lee");
    expect(stub.emails).toEqual(["dana@x.io"]);
    expect(attending(r.meetingId).filter((a) => a.status === "suggested")).toHaveLength(2);
  });

  it("reuses the same stub for the same unknown name in another note", () => {
    note("n1");
    note("n2");
    const a = captureNoteMeeting(db, { noteId: "n1", attendees: ["Sam Okafor"], source: "frontmatter", provenance: "explicit" });
    const b = captureNoteMeeting(db, { noteId: "n2", attendees: ["sam okafor"], source: "frontmatter", provenance: "explicit" });
    expect(b.created).toEqual([]);
    expect(b.attendees).toEqual(a.created);
  });

  it("removes only the attendees this source no longer lists", () => {
    note("n1");
    const ana = person("Ana");
    const ben = person("Ben");
    const cal = person("Cal");
    const first = captureNoteMeeting(db, { noteId: "n1", attendees: ["Ana", "Ben"], source: "frontmatter", provenance: "explicit" });
    addAttendee(db, { meetingId: first.meetingId, personId: cal.id, source: "manual", provenance: "explicit" });
    const second = captureNoteMeeting(db, { noteId: "n1", attendees: ["Ana"], source: "frontmatter", provenance: "explicit" });
    expect(second.removed).toEqual([ben.id]);
    expect(attending(first.meetingId).map((a) => a.personId).sort()).toEqual([ana.id, cal.id].sort());
  });

  it("is idempotent", () => {
    note("n1");
    person("Ana");
    captureNoteMeeting(db, { noteId: "n1", attendees: ["Ana", "Zed"], source: "frontmatter", provenance: "explicit" });
    const again = captureNoteMeeting(db, { noteId: "n1", attendees: ["Ana", "Zed"], source: "frontmatter", provenance: "explicit" });
    expect(again.created).toEqual([]);
    expect(again.removed).toEqual([]);
    expect(listAttendees(db, again.meetingId)).toHaveLength(2);
  });

  it("updates the date of an existing meeting", () => {
    note("n1");
    const r = captureNoteMeeting(db, { noteId: "n1", attendees: [], date: "2026-11-10T00:00:00.000Z", source: "frontmatter", provenance: "explicit" });
    captureNoteMeeting(db, { noteId: "n1", attendees: [], date: "2026-11-12T00:00:00.000Z", source: "frontmatter", provenance: "explicit" });
    const m = db.prepare("SELECT starts_at FROM meetings WHERE id = ?").get(r.meetingId) as { starts_at: string };
    expect(m.starts_at).toBe("2026-11-12T00:00:00.000Z");
  });
});

describe("renderMeetingFrontmatter", () => {
  it("returns null for a note that isn't a meeting", () => {
    note("n1");
    expect(renderMeetingFrontmatter(db, "n1")).toBeNull();
  });

  it("writes persona wikilinks or names, and keeps unresolved values as typed", () => {
    note("n1");
    const persona = note("p-ana", "Ana Ruiz");
    const ana = person("Ana Ruiz", { personaNoteId: persona.id });
    person("Ben Ito");
    person("Chris");
    person("Chris");
    captureNoteMeeting(db, { noteId: "n1", attendees: ["Ana Ruiz", "Ben Ito", "Chris"], date: "2026-11-10", source: "frontmatter", provenance: "explicit" });
    const fm = renderMeetingFrontmatter(db, "n1", ["Ana Ruiz", "Ben Ito", "Chris"]);
    expect(fm).toMatchObject({ attendees: ["[[Ana Ruiz]]", "Ben Ito", "Chris"], date: "2026-11-10", unreferenced: [] });
    expect(ana.id).toBeTruthy();
  });
});

describe("notesAffectedBy", () => {
  it("finds notes through meetings and their attendees", () => {
    note("n1");
    note("n2");
    const ana = person("Ana");
    const m = createMeeting(db, { workspaceId: "ws1", title: "Sync", startsAt: "2026-11-10T09:00:00.000Z", source: "manual" });
    setNoteMeeting(db, "n1", m.id);
    addAttendee(db, { meetingId: m.id, personId: ana.id, source: "manual", provenance: "explicit" });
    expect(notesAffectedBy(db, { personIds: [ana.id] })).toEqual(["n1"]);
    expect(notesAffectedBy(db, { meetingIds: [m.id], noteIds: ["n2"] }).sort()).toEqual(["n1", "n2"]);
  });
});

describe("cleanup", () => {
  it("only the oldest is_me person counts as me", () => {
    const first = person("Me (laptop)", { isMe: true });
    const second = person("Me (desktop)", { isMe: true });
    // Two devices each marked someone as me (sync bypasses the local one-me rule); the older row wins everywhere.
    db.prepare("UPDATE people SET is_me = 1 WHERE id = ?").run(first.id);
    db.prepare("UPDATE people SET created_at = ? WHERE id = ?").run("2026-01-02T00:00:00.000Z", first.id);
    db.prepare("UPDATE people SET created_at = ? WHERE id = ?").run("2026-01-03T00:00:00.000Z", second.id);
    expect(getMe(db, "ws1")?.id).toBe(first.id);
    expect(getPerson(db, first.id)?.isMe).toBe(true);
    expect(getPerson(db, second.id)?.isMe).toBe(false);
  });

  it("deleting a note clears persona links, mentions and action items", () => {
    const n = note("n1");
    const ana = person("Ana", { personaNoteId: n.id });
    addMention(db, n.id, ana.id);
    db.prepare("INSERT INTO note_action_items (note_id, line_key, text, done) VALUES ('n1', 'k1', 'Do it', 0)").run();
    deleteNote(db, n.id);
    expect(getPerson(db, ana.id)?.personaNoteId ?? null).toBeNull();
    expect(db.prepare("SELECT COUNT(*) c FROM note_mentions WHERE note_id = 'n1' AND deleted_at IS NULL").get()).toEqual({ c: 0 });
    expect(db.prepare("SELECT COUNT(*) c FROM note_action_items WHERE note_id = 'n1'").get()).toEqual({ c: 0 });
  });

  it("deleting a project clears People links to its notes", () => {
    const n = note("n1");
    const ana = person("Ana", { personaNoteId: n.id });
    addMention(db, n.id, ana.id);
    deleteProject(db, "proj1");
    expect(getPerson(db, ana.id)?.personaNoteId ?? null).toBeNull();
    expect(db.prepare("SELECT COUNT(*) c FROM note_mentions WHERE deleted_at IS NULL").get()).toEqual({ c: 0 });
  });

  it("merging into another workspace drops links that can't follow", () => {
    seedWorkspace(db, "ws2", "Other");
    seedProject(db, "ws2", "proj2", "Other project");
    const n = note("n1");
    const ana = person("Ana", { personaNoteId: n.id });
    addMention(db, n.id, ana.id);
    captureNoteMeeting(db, { noteId: n.id, attendees: ["Ana"], source: "frontmatter", provenance: "explicit" });
    mergeProject(db, "proj1", "proj2");
    const row = db.prepare("SELECT workspace_id, meeting_id FROM notes WHERE id = 'n1'").get();
    expect(row).toEqual({ workspace_id: "ws2", meeting_id: null });
    expect(getPerson(db, ana.id)?.personaNoteId ?? null).toBeNull();
    expect(db.prepare("SELECT COUNT(*) c FROM note_mentions WHERE deleted_at IS NULL").get()).toEqual({ c: 0 });
  });

  it("merging within a workspace keeps People links", () => {
    seedProject(db, "ws1", "proj2", "Sibling");
    const n = note("n1");
    const ana = person("Ana", { personaNoteId: n.id });
    const r = captureNoteMeeting(db, { noteId: n.id, attendees: ["Ana"], source: "frontmatter", provenance: "explicit" });
    mergeProject(db, "proj1", "proj2");
    expect(db.prepare("SELECT meeting_id FROM notes WHERE id = 'n1'").get()).toEqual({ meeting_id: r.meetingId });
    expect(getPerson(db, ana.id)?.personaNoteId).toBe(n.id);
  });
});

describe("review fixes", () => {
  it("a note moved to another workspace gets its own meeting there", () => {
    seedWorkspace(db, "ws2", "Other");
    seedProject(db, "ws2", "proj2", "Other project");
    note("n1");
    const first = captureNoteMeeting(db, { noteId: "n1", attendees: [], source: "frontmatter", provenance: "explicit" });
    mergeProject(db, "proj1", "proj2");
    const second = captureNoteMeeting(db, { noteId: "n1", attendees: [], source: "frontmatter", provenance: "explicit" });
    expect(second.meetingId).not.toBe(first.meetingId);
    expect((db.prepare("SELECT workspace_id FROM meetings WHERE id = ?").get(second.meetingId) as { workspace_id: string }).workspace_id).toBe("ws2");
  });

  it("a person added by hand stays when the frontmatter drops them", () => {
    note("n1");
    const ana = person("Ana");
    const r = captureNoteMeeting(db, { noteId: "n1", attendees: ["Ana"], source: "frontmatter", provenance: "explicit" });
    addAttendee(db, { meetingId: r.meetingId, personId: ana.id, source: "manual", provenance: "explicit" });
    expect(captureNoteMeeting(db, { noteId: "n1", attendees: [], source: "frontmatter", provenance: "explicit" }).removed).toEqual([]);
    expect(attending(r.meetingId)).toEqual([{ personId: ana.id, status: "confirmed", source: "manual" }]);
  });

  it("keeps a person while any source still lists them", () => {
    note("n1");
    const ana = person("Ana");
    const r = captureNoteMeeting(db, { noteId: "n1", attendees: ["Ana"], source: "frontmatter", provenance: "explicit" });
    captureNoteMeeting(db, { noteId: "n1", attendees: ["Ana"], source: "calendar", provenance: "explicit" });
    // The calendar owns the row now, but both sources are remembered.
    expect(listAttendees(db, r.meetingId)[0].sources.sort()).toEqual(["calendar", "frontmatter"]);
    // A later calendar capture without Ana must not remove her: frontmatter still lists her.
    expect(captureNoteMeeting(db, { noteId: "n1", attendees: [], source: "calendar", provenance: "explicit" }).removed).toEqual([]);
    expect(attending(r.meetingId)).toEqual([{ personId: ana.id, status: "confirmed", source: "frontmatter" }]);
    // Once the last source drops her, she goes.
    expect(captureNoteMeeting(db, { noteId: "n1", attendees: [], source: "frontmatter", provenance: "explicit" }).removed).toEqual([ana.id]);
    expect(attending(r.meetingId)).toEqual([]);
  });

  it("writes a reference that reads back as the same person", () => {
    note("n1");
    const hashTitle = note("p1", "Ana #work");
    const ana = person("Ana Ruiz", { personaNoteId: hashTitle.id });
    const dup1 = person("Sam", { emails: ["sam.a@x.io"] });
    person("Sam");
    captureNoteMeeting(db, { noteId: "n1", attendees: [], personIds: [ana.id, dup1.id], source: "frontmatter", provenance: "explicit" });
    expect(renderMeetingFrontmatter(db, "n1")?.attendees).toEqual(["Ana Ruiz", "sam.a@x.io"]);
  });

  it("renaming a persona note marks its meetings' notes for refresh", () => {
    note("n1");
    const persona = note("p-ana", "Ana Ruiz");
    person("Ana Ruiz", { personaNoteId: persona.id });
    captureNoteMeeting(db, { noteId: "n1", attendees: ["Ana Ruiz"], source: "frontmatter", provenance: "explicit" });
    expect(notesAffectedBy(db, { noteIds: ["p-ana"] }).sort()).toEqual(["n1", "p-ana"]);
  });

  it("an attendee no reference can identify is pinned, so a later read keeps them", () => {
    note("n1");
    const ana = person("Ana");
    person("Ana");
    captureNoteMeeting(db, { noteId: "n1", attendees: [], personIds: [ana.id], source: "frontmatter", provenance: "explicit" });
    const fm = renderMeetingFrontmatter(db, "n1")!;
    expect(fm.unreferenced).toEqual([ana.id]);
    pinUnreferenced(db, fm);
    // The file now says "Ana" (ambiguous); reading it back must keep the original attendee.
    const back = captureNoteMeeting(db, { noteId: "n1", attendees: fm.attendees, source: "frontmatter", provenance: "explicit" });
    expect(back.removed).toEqual([]);
    expect(attending(fm.meetingId).find((a) => a.personId === ana.id)).toMatchObject({ status: "confirmed", source: "manual" });
  });

  it("a renamed persona note's old title isn't kept next to the new one", () => {
    note("n1");
    setPeopleEnabled(db, true);
    const persona = note("p-ana", "Ana Old");
    const ana = person("Ana Ruiz", { personaNoteId: persona.id });
    captureNoteMeeting(db, { noteId: "n1", attendees: ["[[Ana Old]]"], source: "frontmatter", provenance: "explicit" });
    updateNote(db, "p-ana", { title: "Ana New" });
    expect(getPerson(db, ana.id)!.aliases).toContain("Ana Old");
    const fm = renderMeetingFrontmatter(db, "n1", ["[[Ana Old]]"])!;
    expect(fm.attendees).toEqual(["[[Ana New]]"]);
    const back = captureNoteMeeting(db, { noteId: "n1", attendees: ["[[Ana Old]]"], source: "frontmatter", provenance: "explicit" });
    expect(back.created).toEqual([]);
    expect(back.attendees).toEqual([ana.id]);
  });

  it("a renamed title that another note also uses still reads back as the person", () => {
    note("n1");
    setPeopleEnabled(db, true);
    const persona = note("p-ana", "Ana Old");
    const ana = person("Ana Ruiz", { personaNoteId: persona.id });
    captureNoteMeeting(db, { noteId: "n1", attendees: ["[[Ana Old]]"], source: "frontmatter", provenance: "explicit" });
    updateNote(db, "p-ana", { title: "Ana New" });
    note("other", "Ana Old");
    const back = captureNoteMeeting(db, { noteId: "n1", attendees: ["[[Ana Old]]"], source: "frontmatter", provenance: "explicit" });
    expect(back.created).toEqual([]);
    expect(back.attendees).toEqual([ana.id]);
  });

  it("keeps an unresolved wikilink the user wrote, even with no note by that title", () => {
    note("n1");
    const ana = person("Ana");
    captureNoteMeeting(db, { noteId: "n1", attendees: [], personIds: [ana.id], source: "frontmatter", provenance: "explicit" });
    const fm = renderMeetingFrontmatter(db, "n1", ["[[Not Yet Written]]"])!;
    expect(fm.attendees).toEqual(["Ana", "[[Not Yet Written]]"]);
  });

  it("an attendee named with a leading @ round-trips as themselves", () => {
    note("n1");
    const at = person("@Ana");
    person("Ana");
    const r = captureNoteMeeting(db, { noteId: "n1", attendees: [], personIds: [at.id], source: "frontmatter", provenance: "explicit" });
    const fm = renderMeetingFrontmatter(db, "n1")!;
    expect(fm.unreferenced).toEqual([]);
    const back = captureNoteMeeting(db, { noteId: "n1", attendees: fm.attendees, source: "frontmatter", provenance: "explicit" });
    expect(back.removed).toEqual([]);
    expect(back.attendees).toEqual([at.id]);
    expect(attending(r.meetingId)).toHaveLength(1);
  });
});
