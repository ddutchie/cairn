import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import matter from "gray-matter";
import type Database from "better-sqlite3";
import { makeDb, seedProject, seedWorkspace } from "./test-support/db";
import { createNote } from "./db/notes-queries";
import { addAttendee, createPerson, listAttendees, setPeopleEnabled } from "./db/people-queries";
import { findNoteFilePath, writeNoteFile } from "./host-shared/notes-io";
import { capturePeopleFromFile, meetingNotesForSync, refreshMeetingFrontmatter } from "./people-files";

let db: Database.Database;
let ws: string;

beforeEach(() => {
  db = makeDb();
  seedWorkspace(db);
  seedProject(db);
  ws = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-people-"));
  setPeopleEnabled(db, true);
});
afterEach(() => {
  db.close();
  fs.rmSync(ws, { recursive: true, force: true });
});

function noteWithFile(id: string, extra: Record<string, unknown> = {}, body = "Notes\n") {
  const n = createNote(db, { id, projectId: "proj1", workspaceId: "ws1", title: "Weekly sync", content: body });
  writeNoteFile(ws, { id, projectId: "proj1", workspaceId: "ws1", title: n.title, content: body, tagIds: [], linkedNoteIds: [], linkedCardIds: [], isPinned: false, createdAt: n.createdAt, updatedAt: n.updatedAt, projectName: "Test Project" });
  const file = findNoteFilePath(ws, "Test Project", id)!;
  if (Object.keys(extra).length) {
    const parsed = matter(fs.readFileSync(file, "utf-8"));
    fs.writeFileSync(file, matter.stringify(parsed.content, { ...parsed.data, ...extra }));
  }
  return file;
}
const fmOf = (file: string) => matter(fs.readFileSync(file, "utf-8")).data;
const meetingOf = (noteId: string) => (db.prepare("SELECT meeting_id FROM notes WHERE id = ?").get(noteId) as { meeting_id: string | null }).meeting_id;

describe("capturePeopleFromFile", () => {
  it("does nothing while the People layer is off", () => {
    setPeopleEnabled(db, false);
    const file = noteWithFile("n1", { attendees: ["Ana"] });
    expect(capturePeopleFromFile(db, file, "n1")).toBeNull();
    expect(meetingOf("n1")).toBeNull();
  });

  it("ignores a note with a date but no attendees", () => {
    const file = noteWithFile("n1", { date: "2026-11-10" });
    expect(capturePeopleFromFile(db, file, "n1")).toBeNull();
    expect(meetingOf("n1")).toBeNull();
  });

  it("reads attendees and date into a meeting, and removing the key removes them", () => {
    const ana = createPerson(db, { workspaceId: "ws1", name: "Ana" });
    const file = noteWithFile("n1", { attendees: ["[[Ana]]"], date: "2026-11-10" });
    const r = capturePeopleFromFile(db, file, "n1")!;
    expect(r.attendees).toEqual([ana.id]);
    const m = db.prepare("SELECT starts_at FROM meetings WHERE id = ?").get(r.meetingId) as { starts_at: string };
    expect(m.starts_at).toBe("2026-11-10T00:00:00.000Z");

    const parsed = matter(fs.readFileSync(file, "utf-8"));
    delete parsed.data.attendees;
    fs.writeFileSync(file, matter.stringify(parsed.content, parsed.data));
    expect(capturePeopleFromFile(db, file, "n1")?.removed).toEqual([ana.id]);
    expect(listAttendees(db, r.meetingId)).toEqual([]);
  });

  it("accepts a single string value", () => {
    const file = noteWithFile("n1", { attendees: "Ana, Ben" });
    expect(capturePeopleFromFile(db, file, "n1")?.attendees).toHaveLength(2);
  });
});

describe("refreshMeetingFrontmatter", () => {
  it("writes attendees added elsewhere and keeps the rest of the file", () => {
    const file = noteWithFile("n1", { attendees: ["Ana"], tags_custom: "keep me" }, "Body stays\n");
    const r = capturePeopleFromFile(db, file, "n1")!;
    const ben = createPerson(db, { workspaceId: "ws1", name: "Ben" });
    addAttendee(db, { meetingId: r.meetingId, personId: ben.id, source: "manual", provenance: "explicit" });

    const suppressed: string[] = [];
    expect(refreshMeetingFrontmatter(db, ws, ["n1"], (id) => suppressed.push(id)).written).toEqual(["n1"]);
    expect(suppressed).toEqual(["n1"]);
    const fm = fmOf(file);
    expect(fm.attendees).toEqual(["Ana", "Ben"]);
    expect(fm.tags_custom).toBe("keep me");
    expect(fm.id).toBe("n1");
    expect(matter(fs.readFileSync(file, "utf-8")).content.trim()).toBe("Body stays");

    // Nothing changed → no write.
    expect(refreshMeetingFrontmatter(db, ws, ["n1"]).written).toEqual([]);
  });

  it("leaves a note that isn't a meeting alone", () => {
    const file = noteWithFile("n1");
    const before = fs.readFileSync(file, "utf-8");
    expect(refreshMeetingFrontmatter(db, ws, ["n1"]).written).toEqual([]);
    expect(fs.readFileSync(file, "utf-8")).toBe(before);
  });
});

describe("meetingNotesForSync", () => {
  it("maps synced attendee rows to their meeting's notes", () => {
    const file = noteWithFile("n1", { attendees: ["Ana"] });
    const r = capturePeopleFromFile(db, file, "n1")!;
    const att = db.prepare("SELECT id FROM meeting_attendees WHERE meeting_id = ?").get(r.meetingId) as { id: string };
    expect(meetingNotesForSync(db, [{ entity: "meeting_attendees", entity_id: att.id }])).toEqual(["n1"]);
    expect(meetingNotesForSync(db, [{ entity: "tags", entity_id: "t1" }])).toEqual([]);
  });
});

describe("review fixes", () => {
  it("keeps attendees Cairn never captured on a note without a meeting", () => {
    setPeopleEnabled(db, false);
    const file = noteWithFile("n1", { attendees: ["Ana"] });
    setPeopleEnabled(db, true);
    expect(refreshMeetingFrontmatter(db, ws, ["n1"]).written).toEqual([]);
    expect(fmOf(file).attendees).toEqual(["Ana"]);
  });

  it("keeps an ambiguous single-string attendee instead of emptying the list", () => {
    createPerson(db, { workspaceId: "ws1", name: "Chris" });
    createPerson(db, { workspaceId: "ws1", name: "Chris" });
    const file = noteWithFile("n1", { attendees: "Chris" });
    const r = capturePeopleFromFile(db, file, "n1")!;
    expect(r.suggested).toHaveLength(2);
    const ana = createPerson(db, { workspaceId: "ws1", name: "Ana" });
    addAttendee(db, { meetingId: r.meetingId, personId: ana.id, source: "manual", provenance: "explicit" });
    refreshMeetingFrontmatter(db, ws, ["n1"]);
    expect(fmOf(file).attendees).toEqual(["Ana", "Chris"]);
    expect(capturePeopleFromFile(db, file, "n1")?.removed).toEqual([]);
  });

  it("reports a meeting note whose file is missing or unreadable so the caller retries it", () => {
    const file = noteWithFile("n1", { attendees: ["Ana"] });
    capturePeopleFromFile(db, file, "n1");
    const moved = file + ".gone";
    fs.renameSync(file, moved);
    expect(refreshMeetingFrontmatter(db, ws, ["n1"])).toEqual({ written: [], failed: ["n1"] });
    fs.renameSync(moved, file);
    expect(refreshMeetingFrontmatter(db, ws, ["n1"]).failed).toEqual([]);
  });

  it("doesn't retry notes that aren't meetings or are archived", () => {
    noteWithFile("n1");
    expect(refreshMeetingFrontmatter(db, ws, ["n1"]).failed).toEqual([]);
    const file = noteWithFile("n2", { attendees: ["Ana"] });
    capturePeopleFromFile(db, file, "n2");
    db.prepare("UPDATE notes SET archived_at = ? WHERE id = 'n2'").run(new Date().toISOString());
    fs.rmSync(file);
    expect(refreshMeetingFrontmatter(db, ws, ["n2"]).failed).toEqual([]);
  });
});
