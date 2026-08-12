import { describe, it, expect, beforeEach } from "vitest";
import { nextMilestoneToCelebrate, __resetCelebratedMilestones } from "./milestones";

describe("nextMilestoneToCelebrate", () => {
  beforeEach(() => {
    __resetCelebratedMilestones();
  });

  it("returns 0 when there are no cards", () => {
    expect(nextMilestoneToCelebrate("p1", 100, 0)).toBe(0);
    expect(nextMilestoneToCelebrate("p1", 0, 0)).toBe(0);
  });

  it("returns 0 when the rate is 0", () => {
    expect(nextMilestoneToCelebrate("p1", 0, 5)).toBe(0);
  });

  it("celebrates 25 the first time a project crosses it", () => {
    expect(nextMilestoneToCelebrate("p1", 30, 10)).toBe(25);
  });

  it("does not re-celebrate a milestone already fired for the same project", () => {
    expect(nextMilestoneToCelebrate("p1", 30, 10)).toBe(25);
    // Same session, same project, same/just-past milestone → no re-fire.
    expect(nextMilestoneToCelebrate("p1", 30, 10)).toBe(0);
    expect(nextMilestoneToCelebrate("p1", 45, 10)).toBe(0);
  });

  it("celebrates each milestone once as a project progresses", () => {
    expect(nextMilestoneToCelebrate("p1", 25, 4)).toBe(25);
    expect(nextMilestoneToCelebrate("p1", 50, 4)).toBe(50);
    expect(nextMilestoneToCelebrate("p1", 75, 4)).toBe(75);
    expect(nextMilestoneToCelebrate("p1", 100, 4)).toBe(100);
    // Fully celebrated — nothing more to fire.
    expect(nextMilestoneToCelebrate("p1", 100, 4)).toBe(0);
  });

  it("skips straight to the highest crossed milestone (jump from 20% to 80%)", () => {
    expect(nextMilestoneToCelebrate("p1", 80, 10)).toBe(75);
  });

  it("tracks milestones per project independently", () => {
    // A jump straight to 100% fires only the highest milestone (100), not a
    // 25-then-50-then-75 cascade.
    expect(nextMilestoneToCelebrate("p1", 100, 2)).toBe(100);
    expect(nextMilestoneToCelebrate("p1", 100, 2)).toBe(0);
    // p2 has its own map — 100% fires its own 100 milestone.
    expect(nextMilestoneToCelebrate("p2", 100, 2)).toBe(100);
  });
});
