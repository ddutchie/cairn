import { describe, it, expect } from "vitest";
import { boardStatus, calendarStatus } from "./project-status";

const cols = [
  { id: "b", name: "Backlog", type: "backlog" },
  { id: "p", name: "In Progress", type: "in_progress" },
  { id: "d", name: "Done", type: "done" },
];

describe("boardStatus", () => {
  it("counts open / done / important and per-column totals", () => {
    const s = boardStatus(
      cols,
      [
        { column_id: "b", priority: "high" },
        { column_id: "b", priority: "low" },
        { column_id: "p", priority: "urgent" },
        { column_id: "d", priority: "urgent" },
      ],
      [],
      "2026-10-13",
    );
    expect(s.open).toBe(3);
    expect(s.done).toBe(1);
    expect(s.important).toBe(2); // the done urgent one doesn't count
    expect(s.perColumn.map((c) => c.count)).toEqual([2, 1, 1]);
    expect(s.perColumn[2].done).toBe(true);
  });

  it("separates overdue from due-today, ignoring done tasks", () => {
    const s = boardStatus(
      cols,
      [],
      [
        { due_date: "2026-10-11", is_done: 0 },
        { due_date: "2026-10-13", is_done: 0 },
        { due_date: "2026-10-01", is_done: 1 },
        { due_date: "2026-10-20", is_done: 0 },
      ],
      "2026-10-13",
    );
    expect(s.overdue).toBe(1);
    expect(s.dueToday).toBe(1);
  });
});

describe("calendarStatus", () => {
  // 2026-10-13 is a Tuesday: its Sunday-start week is Oct 11 - Oct 17.
  const dated = [
    { due_date: "2026-10-11", is_done: 0 }, // overdue, this week
    { due_date: "2026-10-13", is_done: 0 }, // today
    { due_date: "2026-10-17", is_done: 0 }, // end of week
    { due_date: "2026-10-18", is_done: 0 }, // next week, same month
    { due_date: "2026-11-02", is_done: 0 }, // next month
    { due_date: "2026-10-14", is_done: 1 }, // done: ignored
  ];
  it("counts today / week / month / overdue", () => {
    expect(calendarStatus(dated, 3, "2026-10-13")).toEqual({ today: 1, week: 3, month: 4, overdue: 1, unscheduled: 3 });
  });
  it("handles a week that spans months", () => {
    // 2026-10-31 (Sat): week is Oct 25 - Oct 31; 2026-11-01 is the next week.
    const s = calendarStatus([{ due_date: "2026-11-01", is_done: 0 }, { due_date: "2026-10-26", is_done: 0 }], 0, "2026-10-31");
    expect(s.week).toBe(1);
    expect(s.month).toBe(1);
  });
});
