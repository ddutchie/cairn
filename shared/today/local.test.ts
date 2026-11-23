import { describe, it, expect } from "vitest";
import { buildLocalToday, localDay, localDayBounds, localTodayLine } from "./local";

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
