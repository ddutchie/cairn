import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { makeDb, seedProject, seedWorkspace } from "../test-support/db";
import {
  addAttendee, createMeeting, createPerson, deleteMeeting, getMeeting, listAttendees, removeAttendee, setNoteMeeting, updatePerson,
} from "./people-queries";
import {
  duePrepTargets, eventExternalId, getCadenceNudges, localInstant, oneOnOneDates, syncCalendarMeetings,
} from "./people-oneonone";
import { createNote } from "./notes-queries";
import { calendarMeetingId } from "../../shared/people/ids";
import { normalizeEvent, type TodayEvent } from "../../shared/today/brief";

let db: Database.Database;
beforeEach(() => { db = makeDb(); seedWorkspace(db); seedProject(db); });
afterEach(() => db.close());

const DAY = 86_400_000;
const person = (name: string, extra: Partial<Parameters<typeof createPerson>[1]> = {}) => createPerson(db, { workspaceId: "ws1", name, ...extra });
const event = (extra: Partial<TodayEvent> = {}): TodayEvent => ({ id: "evt-1", title: "1:1 with Ana", start: "10:00", end: "10:30", ...extra });
const mid = (e: TodayEvent, date = "2026-11-18") => calendarMeetingId("ws1", eventExternalId(date, e));
const updatedAt = (id: string) => (db.prepare("SELECT updated_at FROM meetings WHERE id = ?").get(id) as { updated_at: string }).updated_at;

describe("syncCalendarMeetings", () => {
  it("makes a calendar meeting with the matched people as attendees", () => {
    const ana = person("Ana Ruiz", { emails: ["ana@acme.io"] });
    const e = event({ attendees: [{ email: "ana@acme.io" }, { email: "me@acme.io", self: true }], seriesId: "Weekly 1:1" });
    const r = syncCalendarMeetings(db, "ws1", "2026-11-18", [e]);
    expect(r).toEqual({ meetings: 1, skipped: 0 });
    const m = getMeeting(db, mid(e))!;
    expect(m).toMatchObject({ title: "1:1 with Ana", source: "calendar", externalId: "evt-1@2026-11-18", seriesKey: "ser:weekly 1:1" });
    expect(new Date(m.startsAt).getHours()).toBe(10);
    expect(listAttendees(db, m.id).map((a) => [a.personId, a.status, a.source])).toEqual([[ana.id, "confirmed", "calendar"]]);
  });

  it("skips events with no invitees (or only the user) and bad times", () => {
    const r = syncCalendarMeetings(db, "ws1", "2026-11-18", [
      event({ id: "a" }), event({ id: "b", attendees: [{ name: "Me", self: true }] }), event({ id: "c", start: "25:99", attendees: [{ name: "Ana" }] }),
    ]);
    expect(r).toEqual({ meetings: 0, skipped: 3 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM meetings").get()).toEqual({ n: 0 });
  });

  it("makes two suggested attendees of a name two people share", () => {
    const a = person("Chris");
    const b = person("Chris");
    const e = event({ attendees: [{ name: "Chris" }] });
    syncCalendarMeetings(db, "ws1", "2026-11-18", [e]);
    const rows = listAttendees(db, mid(e));
    expect(rows.map((r) => r.personId).sort()).toEqual([a.id, b.id].sort());
    expect(rows.every((r) => r.status === "suggested")).toBe(true);
  });

  it("creates stub people for unknown invitees only in small meetings", () => {
    const small = event({ id: "s", attendees: [{ name: "Zed Newcomer" }] });
    const big = event({ id: "b", start: "11:00", attendees: Array.from({ length: 9 }, (_, i) => ({ name: `Guest ${i}` })) });
    syncCalendarMeetings(db, "ws1", "2026-11-18", [small, big]);
    expect(db.prepare("SELECT name, status FROM people WHERE deleted_at IS NULL").all()).toEqual([{ name: "Zed Newcomer", status: "suggested" }]);
    expect(listAttendees(db, mid(big))).toHaveLength(0);
    expect(listAttendees(db, mid(small))).toHaveLength(1);
  });

  it("is idempotent and writes nothing the second time", () => {
    person("Ana Ruiz");
    const e = event({ attendees: [{ name: "Ana Ruiz" }] });
    syncCalendarMeetings(db, "ws1", "2026-11-18", [e]);
    const before = {
      meeting: db.prepare("SELECT * FROM meetings").all(), att: db.prepare("SELECT * FROM meeting_attendees").all(), people: db.prepare("SELECT * FROM people").all(),
    };
    syncCalendarMeetings(db, "ws1", "2026-11-18", [e]);
    expect({
      meeting: db.prepare("SELECT * FROM meetings").all(), att: db.prepare("SELECT * FROM meeting_attendees").all(), people: db.prepare("SELECT * FROM people").all(),
    }).toEqual(before);
  });

  it("updates a moved meeting in place", () => {
    person("Ana Ruiz");
    const e = event({ attendees: [{ name: "Ana Ruiz" }] });
    syncCalendarMeetings(db, "ws1", "2026-11-18", [e]);
    syncCalendarMeetings(db, "ws1", "2026-11-18", [{ ...e, start: "14:00", end: "14:30", title: "1:1 (moved)" }]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM meetings").get()).toEqual({ n: 1 });
    expect(getMeeting(db, mid(e))).toMatchObject({ title: "1:1 (moved)" });
    expect(new Date(getMeeting(db, mid(e))!.startsAt).getHours()).toBe(14);
  });

  it("drops only the calendar's claim when an invitee leaves, and never someone the user removed", () => {
    const ana = person("Ana Ruiz");
    const ben = person("Ben Okafor");
    const cat = person("Cat Lee");
    const e = event({ attendees: [{ name: "Ana Ruiz" }, { name: "Ben Okafor" }, { name: "Cat Lee" }] });
    syncCalendarMeetings(db, "ws1", "2026-11-18", [e]);
    const id = mid(e);
    addAttendee(db, { meetingId: id, personId: ben.id, source: "manual" }); // the user also listed Ben
    removeAttendee(db, id, cat.id); // the user took Cat off
    syncCalendarMeetings(db, "ws1", "2026-11-18", [{ ...e, attendees: [{ name: "Ana Ruiz" }, { name: "Cat Lee" }] }]);
    const ids = listAttendees(db, id).map((a) => a.personId);
    expect(ids).toContain(ana.id);
    expect(ids).toContain(ben.id); // manual claim survives the calendar dropping them
    expect(ids).not.toContain(cat.id); // stays removed while the calendar still lists them
  });

  it("does not bring back a meeting the user deleted", () => {
    person("Ana Ruiz");
    const e = event({ attendees: [{ name: "Ana Ruiz" }] });
    syncCalendarMeetings(db, "ws1", "2026-11-18", [e]);
    deleteMeeting(db, mid(e));
    const r = syncCalendarMeetings(db, "ws1", "2026-11-18", [e]);
    expect(r).toEqual({ meetings: 0, skipped: 1 });
    expect(getMeeting(db, mid(e))).toBeNull();
  });

  it("keeps a recurring event's days apart", () => {
    person("Ana Ruiz");
    const e = event({ attendees: [{ name: "Ana Ruiz" }] });
    syncCalendarMeetings(db, "ws1", "2026-11-18", [e]);
    syncCalendarMeetings(db, "ws1", "2026-11-25", [e]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM meetings").get()).toEqual({ n: 2 });
  });

  it("leaves a meeting's sync stamp alone when nothing changed", () => {
    person("Ana Ruiz");
    const e = event({ attendees: [{ name: "Ana Ruiz" }] });
    syncCalendarMeetings(db, "ws1", "2026-11-18", [e]);
    db.prepare("UPDATE meetings SET updated_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(mid(e));
    syncCalendarMeetings(db, "ws1", "2026-11-18", [e]);
    expect(updatedAt(mid(e))).toBe("2020-01-01T00:00:00.000Z");
  });
});

describe("calendar cancellations and ids", () => {
  const T = Date.parse("2026-11-18T06:00:00");
  const withAna = (id: string, start = "10:00") => event({ id, start, attendees: [{ email: "ana@acme.io" }] });
  it("tombstones a future meeting a later brief no longer lists, with its calendar attendance", () => {
    person("Ana", { emails: ["ana@acme.io"] });
    const a = withAna("evt-a"), b = withAna("evt-b", "14:00");
    syncCalendarMeetings(db, "ws1", "2026-11-18", [a, b], T);
    syncCalendarMeetings(db, "ws1", "2026-11-18", [b], T);
    expect(getMeeting(db, mid(a))).toBeNull();
    expect(getMeeting(db, mid(b))).not.toBeNull();
    expect(listAttendees(db, mid(a))).toEqual([]);
  });
  it("keeps meetings under way or past, ones with notes, other days, and believes nothing from an empty brief", () => {
    person("Ana", { emails: ["ana@acme.io"] });
    const past = withAna("evt-p", "08:00"), other = withAna("evt-o", "15:00"), keep = withAna("evt-k", "16:00");
    syncCalendarMeetings(db, "ws1", "2026-11-18", [past, keep], T);
    syncCalendarMeetings(db, "ws1", "2026-11-19", [other], T);
    syncCalendarMeetings(db, "ws1", "2026-11-18", [keep], Date.parse("2026-11-18T09:00:00"));
    expect(getMeeting(db, mid(past))).not.toBeNull();
    expect(getMeeting(db, mid(other, "2026-11-19"))).not.toBeNull();
    syncCalendarMeetings(db, "ws1", "2026-11-18", [], T);
    expect(getMeeting(db, mid(keep))).not.toBeNull();
  });
  it("drops only the calendar claims of a cancelled meeting that has notes", () => {
    person("Ana", { emails: ["ana@acme.io"] });
    const a = withAna("evt-a"), b = withAna("evt-b", "14:00");
    syncCalendarMeetings(db, "ws1", "2026-11-18", [a, b], T);
    createNote(db, { id: "n1", projectId: "proj1", workspaceId: "ws1", title: "Notes", content: "" });
    setNoteMeeting(db, "n1", mid(a));
    syncCalendarMeetings(db, "ws1", "2026-11-18", [b], T);
    expect(getMeeting(db, mid(a))).not.toBeNull();
    expect(listAttendees(db, mid(a))).toEqual([]);
    expect(oneOnOneDates(db, "ws1", T).size).toBe(1);
  });
  it("makes no meeting from an event without the calendar's own id (a reschedule would duplicate it)", () => {
    person("Ana", { emails: ["ana@acme.io"] });
    const noId = normalizeEvent({ title: "1:1 with Ana", start: "10:00", attendees: [{ email: "ana@acme.io" }] }, true)!;
    expect(syncCalendarMeetings(db, "ws1", "2026-11-18", [noId], T)).toEqual({ meetings: 0, skipped: 1 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM meetings").get()).toEqual({ n: 0 });
  });
  it("a tombstoned 1:1 no longer suppresses the nudge or draws a prep", () => {
    const ana = person("Ana", { emails: ["ana@acme.io"], cadence: "weekly" });
    const old = createMeeting(db, { workspaceId: "ws1", title: "1:1", startsAt: new Date(T - 30 * DAY).toISOString(), source: "note" });
    addAttendee(db, { meetingId: old.id, personId: ana.id });
    const soon = withAna("evt-s", "06:30");
    syncCalendarMeetings(db, "ws1", "2026-11-18", [soon, withAna("evt-t", "20:00")], T);
    expect(getCadenceNudges(db, "ws1", new Date(T))).toHaveLength(0);
    syncCalendarMeetings(db, "ws1", "2026-11-18", [withAna("evt-t", "20:00")], T);
    expect(duePrepTargets(db, "ws1", T)).toEqual([]);
  });
});

describe("localInstant", () => {
  it("builds a local instant and rejects malformed input", () => {
    expect(new Date(localInstant("2026-11-18", "9:05")!).getMinutes()).toBe(5);
    expect(localInstant("18/11/2026", "09:00")).toBeNull();
    expect(localInstant("2026-11-18", "late")).toBeNull();
  });
});

describe("1:1 dates and cadence nudges", () => {
  const now = new Date("2026-11-18T12:00:00Z");
  const meet = (title: string, daysAgo: number, people: string[]) => {
    const m = createMeeting(db, { workspaceId: "ws1", title, startsAt: new Date(now.getTime() - daysAgo * DAY).toISOString() });
    for (const p of people) addAttendee(db, { meetingId: m.id, personId: p });
    return m;
  };

  it("counts a meeting as a 1:1 when the person is the only other confirmed attendee", () => {
    const me = person("Me", { isMe: true });
    const ana = person("Ana", { cadence: "weekly" });
    const ben = person("Ben");
    meet("1:1", 20, [me.id, ana.id]);
    meet("Team sync", 3, [me.id, ana.id, ben.id]);
    const d = oneOnOneDates(db, "ws1", now.getTime()).get(ana.id)!;
    expect(Date.parse(d.last!)).toBe(now.getTime() - 20 * DAY);
  });

  it("nudges someone past their cadence, with the gap in the title", () => {
    const ana = person("Ana Ruiz", { cadence: "weekly" });
    meet("1:1", 22, [ana.id]);
    expect(getCadenceNudges(db, "ws1", now)).toEqual([{ id: `nudge-${ana.id}`, personId: ana.id, name: "Ana Ruiz", title: "No 1:1 with Ana Ruiz in 3 weeks", days: 22 }]);
  });

  it("stays quiet within the cadence, with no cadence, with no 1:1 yet, for archived people and when one is booked", () => {
    const fresh = person("Fresh", { cadence: "weekly" });
    meet("1:1", 5, [fresh.id]);
    const noCadence = person("NoCadence");
    meet("1:1", 60, [noCadence.id]);
    person("Never", { cadence: "monthly" });
    const gone = person("Gone", { cadence: "weekly" });
    meet("1:1", 40, [gone.id]);
    updatePerson(db, gone.id, { archivedAt: now.toISOString() });
    const booked = person("Booked", { cadence: "weekly" });
    meet("1:1", 30, [booked.id]);
    const upcoming = createMeeting(db, { workspaceId: "ws1", title: "1:1", startsAt: new Date(now.getTime() + 2 * DAY).toISOString() });
    addAttendee(db, { meetingId: upcoming.id, personId: booked.id });
    expect(getCadenceNudges(db, "ws1", now)).toEqual([]);
  });

  it("nudges again when the booked 1:1 is further off than a few days", () => {
    const late = person("Late", { cadence: "weekly" });
    meet("1:1", 30, [late.id]);
    const upcoming = createMeeting(db, { workspaceId: "ws1", title: "1:1", startsAt: new Date(now.getTime() + 9 * DAY).toISOString() });
    addAttendee(db, { meetingId: upcoming.id, personId: late.id });
    expect(getCadenceNudges(db, "ws1", now).map((n) => n.name)).toEqual(["Late"]);
  });

  it("orders the longest gap first", () => {
    const a = person("A", { cadence: "weekly" });
    const b = person("B", { cadence: "weekly" });
    meet("1:1", 12, [a.id]);
    meet("1:1", 30, [b.id]);
    expect(getCadenceNudges(db, "ws1", now).map((n) => n.name)).toEqual(["B", "A"]);
  });
});

describe("duePrepTargets", () => {
  const now = Date.parse("2026-11-18T12:00:00Z");
  const upcoming = (minutes: number, source: "calendar" | "note", people: string[]) => {
    const m = createMeeting(db, { workspaceId: "ws1", title: "1:1", startsAt: new Date(now + minutes * 60_000).toISOString(), source });
    for (const p of people) addAttendee(db, { meetingId: m.id, personId: p });
    return m;
  };

  it("finds people with a cadence on a calendar meeting starting soon, soonest meeting first", () => {
    const ana = person("Ana", { cadence: "weekly" });
    const m1 = upcoming(90, "calendar", [ana.id]);
    upcoming(30, "calendar", [ana.id]);
    const targets = duePrepTargets(db, "ws1", now);
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({ personId: ana.id });
    expect(targets[0].meetingId).not.toBe(m1.id);
  });

  it("ignores people without a cadence, note-made meetings, past and far-off meetings", () => {
    const none = person("None");
    const ana = person("Ana", { cadence: "weekly" });
    upcoming(30, "calendar", [none.id]);
    upcoming(30, "note", [ana.id]);
    upcoming(-30, "calendar", [ana.id]);
    upcoming(600, "calendar", [ana.id]);
    expect(duePrepTargets(db, "ws1", now)).toEqual([]);
  });

  it("is for small meetings only: a 1:1 or one other person, not a big group", () => {
    const ana = person("Ana", { cadence: "weekly" });
    const others = [person("B"), person("C")];
    upcoming(30, "calendar", [ana.id]);
    expect(duePrepTargets(db, "ws1", now)).toHaveLength(1);
    db.prepare("DELETE FROM meeting_attendees").run(); db.prepare("DELETE FROM meetings").run();
    upcoming(30, "calendar", [ana.id, ...others.map((o) => o.id)]);
    expect(duePrepTargets(db, "ws1", now)).toEqual([]);
  });
});
