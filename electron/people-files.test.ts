import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import matter from "gray-matter";
import type Database from "better-sqlite3";
import { makeDb, seedProject, seedWorkspace } from "./test-support/db";
import { createNote } from "./db/notes-queries";
import { addAttendee, createPerson, listAttendees, setPeopleEnabled } from "./db/people-queries";
import { findNoteFilePath, writeNoteFile } from "./host-shared/notes-io";
import { FrontmatterRetryQueue, capturePeopleFromFile, meetingNotesForSync, refreshMeetingFrontmatter } from "./people-files";

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

describe("FrontmatterRetryQueue", () => {
  it("backs off but never drops a note that keeps failing, and recovers once it succeeds", () => {
    const q = new FrontmatterRetryQueue();
    let ids = q.next(["a"]);
    q.report(ids, ["a"]);
    let attempts = 1;
    // Far past the old 20-try cap, with gaps growing to 64 ticks.
    for (let i = 0; i < 2000; i++) {
      ids = q.next([]);
      if (ids.length) { attempts++; q.report(ids, ["a"]); }
    }
    expect(q.size).toBe(1);
    expect(attempts).toBeGreaterThan(20);
    expect(attempts).toBeLessThan(80);
    // The file finally exists: the next due retry succeeds and clears the queue.
    for (let i = 0; i < 70; i++) {
      ids = q.next([]);
      if (ids.length) { q.report(ids, []); break; }
    }
    expect(q.size).toBe(0);
  });
});

describe("round-three review fixes", () => {
  it("a scalar frontmatter value naming @Ana keeps @Ana, not Ana", () => {
    const file = noteWithFile("n1", { attendees: '"@Ana"' });
    const at = createPerson(db, { workspaceId: "ws1", name: "@Ana" });
    createPerson(db, { workspaceId: "ws1", name: "Ana" });
    const r = capturePeopleFromFile(db, file, "n1")!;
    expect(r.attendees).toEqual([at.id]);
    expect(r.removed).toEqual([]);
    expect(listAttendees(db, r.meetingId).map((a) => a.personId)).toEqual([at.id]);
  });

  it("a read failure while writing is reported as failed so it is retried", () => {
    const file = noteWithFile("n1", { attendees: ["Ana"] });
    const r = capturePeopleFromFile(db, file, "n1")!;
    const ben = createPerson(db, { workspaceId: "ws1", name: "Ben" });
    addAttendee(db, { meetingId: r.meetingId, personId: ben.id, source: "manual", provenance: "explicit" });
    const real = fs.readFileSync;
    let reads = 0;
    const spy = vi.spyOn(fs, "readFileSync").mockImplementation(((...args: Parameters<typeof fs.readFileSync>) => {
      // Reads of the file: 1 findNoteFilePath, 2 readMeetingProps, 3 writeMeetingFrontmatter. Fail the third.
      if (String(args[0]) === file && ++reads === 3) throw new Error("EBUSY");
      return real(...args);
    }) as typeof fs.readFileSync);
    try {
      const out = refreshMeetingFrontmatter(db, ws, ["n1"]);
      expect(reads).toBeGreaterThanOrEqual(3); // the failing read was the write path's own
      expect(out.failed).toEqual(["n1"]);
      expect(out.written).toEqual([]);
    } finally {
      spy.mockRestore();
    }
    expect(refreshMeetingFrontmatter(db, ws, ["n1"]).written).toEqual(["n1"]);
  });

  it("a persona rename that arrives by sync (no onNoteRenamed) still resolves the old title", () => {
    const persona = createNote(db, { id: "p-ana", projectId: "proj1", workspaceId: "ws1", title: "Ana Old", content: "" });
    const ana = createPerson(db, { workspaceId: "ws1", name: "Ana Ruiz", personaNoteId: persona.id });
    const file = noteWithFile("n1", { attendees: ["[[Ana Old]]"] });
    capturePeopleFromFile(db, file, "n1");
    // Mobile renames the note directly; the sync engine applies the row without our hook.
    db.prepare("UPDATE notes SET title = 'Ana New' WHERE id = 'p-ana'").run();
    expect(refreshMeetingFrontmatter(db, ws, ["n1"]).written).toEqual(["n1"]);
    expect(fmOf(file).attendees).toEqual(["[[Ana New]]"]);
    // An external editor re-saves the old link: it still means Ana, no stub.
    fs.writeFileSync(file, matter.stringify("Notes\n", { ...fmOf(file), attendees: ["[[Ana Old]]"] }));
    const back = capturePeopleFromFile(db, file, "n1")!;
    expect(back.created).toEqual([]);
    expect(back.attendees).toEqual([ana.id]);
  });
});
