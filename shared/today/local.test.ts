import { describe, it, expect } from "vitest";
import { buildLocalToday, freeTimeLine, localDay, localDayBounds, localTodayLine } from "./local";

const NOW = new Date(2026, 10, 22, 14, 30).getTime(); // Sun 22 Nov 2026, local
const task = (id: string, dueDate: string, title = id) => ({ id, title, dueDate });

describe("buildLocalToday", () => {
  it("splits overdue from due today by local calendar day and drops the rest", () => {
    const t = buildLocalToday({ tasks: [task("a", "2026-11-22"), task("b", "2026-11-20"), task("c", "2026-11-23"), task("d", "2026-11-22T23:00:00")], meetings: [], peopleDue: [] }, NOW);
    expect(t.overdue.map((x) => x.id)).toEqual(["b"]);
    expect(t.dueToday.map((x) => x.id)).toEqual(["a", "d"]);
  });

  it("sorts overdue oldest first, meetings earliest first, people most overdue first", () => {
    const t = buildLocalToday({
      tasks: [task("late", "2026-11-21"), task("later", "2026-11-18")],
      meetings: [{ id: "m2", title: "B", startsAt: "2026-11-22T15:00:00.000Z" }, { id: "m1", title: "A", startsAt: "2026-11-22T09:00:00.000Z" }],
      peopleDue: [{ id: "p1", name: "Ana", daysOver: 2 }, { id: "p2", name: "Sam", daysOver: 9 }],
    }, NOW);
    expect(t.overdue.map((x) => x.id)).toEqual(["later", "late"]);
    expect(t.meetings.map((x) => x.id)).toEqual(["m1", "m2"]);
    expect(t.peopleDue.map((x) => x.id)).toEqual(["p2", "p1"]);
  });
});

describe("day helpers", () => {
  it("localDay is the local calendar date", () => {
    expect(localDay(NOW)).toBe("2026-11-22");
  });
  it("localDayBounds spans exactly the local day", () => {
    const { start, end } = localDayBounds(NOW);
    expect(new Date(start).getHours()).toBe(0);
    expect(new Date(end).getDate()).toBe(23);
    expect(new Date(NOW).toISOString() >= start && new Date(NOW).toISOString() < end).toBe(true);
  });
});

describe("localTodayLine", () => {
  it("lists what there is, in order", () => {
    const t = buildLocalToday({ tasks: [task("b", "2026-11-20"), task("a", "2026-11-22")], meetings: [{ id: "m", title: "x", startsAt: "2026-11-22T09:00:00.000Z" }], peopleDue: [] }, NOW);
    expect(localTodayLine(t)).toBe("1 overdue, 1 due today, 1 meeting");
  });
  it("is calm when empty", () => {
    expect(localTodayLine(buildLocalToday({ tasks: [], meetings: [], peopleDue: [] }, NOW))).toBe("Nothing due today");
  });
});

const at = (h: number, m = 0) => new Date(2026, 10, 22, h, m).toISOString();

describe("day strip", () => {
  it("turns meetings into busy blocks and counts the free time still ahead", () => {
    // NOW is 14:30; meetings 9-10 (gone) and 15:00-16:00.
    const t = buildLocalToday({
      tasks: [], peopleDue: [],
      meetings: [{ id: "a", title: "A", startsAt: at(9), endsAt: at(10) }, { id: "b", title: "B", startsAt: at(15), endsAt: at(16) }],
    }, NOW);
    expect(t.day.meetingsLeft).toBe(1);
    expect(t.day.nextMeeting?.id).toBe("b");
    // Free ahead: 14:30-15:00 (30m) and 16:00-18:00 (120m).
    expect(t.day.freeLeft).toBe(150);
    expect(freeTimeLine(t.day)).toBe("2h 30m free, longest 2h");
  });
  it("says nothing about free time when the day is over", () => {
    const late = new Date(2026, 10, 22, 19, 0).getTime();
    expect(freeTimeLine(buildLocalToday({ tasks: [], meetings: [], peopleDue: [] }, late).day)).toBeNull();
  });
  it("cuts a meeting that runs past midnight instead of dropping it", () => {
    const next = new Date(2026, 10, 23, 1, 0).toISOString();
    const t = buildLocalToday({ tasks: [], peopleDue: [], meetings: [{ id: "n", title: "Late", startsAt: at(22), endsAt: next }] }, NOW);
    const meeting = t.day.blocks.find((b) => b.kind === "meeting");
    expect(meeting?.end).toBe(24 * 60);
  });
});

describe("you owe", () => {
  const owed = { noteId: "n1", noteTitle: "1:1", text: "Send the deck", lineKey: "k", bodyDigest: "d" };
  it("shows in the headline and defaults to none", () => {
    expect(buildLocalToday({ tasks: [], meetings: [], peopleDue: [] }, NOW).youOwe).toEqual([]);
    expect(localTodayLine(buildLocalToday({ tasks: [], meetings: [], peopleDue: [], youOwe: [owed] }, NOW))).toBe("1 you owe");
  });
});
