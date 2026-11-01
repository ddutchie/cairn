import { describe, expect, it } from "vitest";
import { describeCron, describeInterval, scheduleLabel } from "./automation-format";

describe("describeCron", () => {
  it.each([
    ["0 8 * * 1-5", "Weekdays at 08:00"],
    ["0 16 * * 5", "Fridays at 16:00"],
    ["30 9 * * 1,3,5", "Monday, Wednesday and Friday at 09:30"],
    ["0 10 * * 6,0", "Weekends at 10:00"],
    ["0 10 * * 0-6", "Daily at 10:00"],
    ["0 9 * * 1-3", "Monday–Wednesday at 09:00"],
    ["15 7 * * *", "Daily at 07:15"],
    ["0 9 1 * *", "Monthly on day 1 at 09:00"],
    ["*/15 * * * *", "Every 15 minutes"],
    ["0 */6 * * *", "Every 6 hours"],
    ["5 */1 * * *", "Every hour at :05"],
  ])("%s → %s", (expr, text) => {
    expect(describeCron(expr)).toBe(text);
  });

  it("returns null for shapes it can't say simply", () => {
    expect(describeCron("0 9 1-7 * 1")).toBeNull();
    expect(describeCron("0 9 * 1 *")).toBeNull();
    expect(describeCron("@daily")).toBeNull();
  });
});

describe("scheduleLabel", () => {
  it("uses singular units and falls back to the raw cron", () => {
    expect(describeInterval("every 1 hours")).toBe("Every hour");
    expect(scheduleLabel({ scheduleKind: "every", scheduleExpr: "every 6 hours" })).toBe("Every 6 hours");
    expect(scheduleLabel({ scheduleKind: "cron", scheduleExpr: "0 9 L * *" })).toBe("0 9 L * *");
  });
});
