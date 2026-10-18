import { describe, expect, it } from "vitest";
import { hash32, layoutStones, MAX_STONES, MIN_STONE_W, STACK_WIDTH, type StoneInput } from "./stones";

const note = (i: number, size = 600): StoneInput => ({
  id: `note-${i}`,
  projectId: "p1",
  title: `Note ${i}`,
  size,
  createdAt: `2026-10-${String(10 + i).padStart(2, "0")}T09:00:00.000Z`,
});

describe("hash32", () => {
  it("is stable and spreads different ids", () => {
    expect(hash32("a")).toBe(hash32("a"));
    expect(hash32("a")).not.toBe(hash32("b"));
    expect(hash32("")).toBe(0x811c9dc5);
  });
});

describe("layoutStones", () => {
  it("is empty with no notes", () => {
    expect(layoutStones([])).toEqual({ stones: [], height: 0 });
  });

  it("is deterministic, whatever order the notes arrive in", () => {
    const a = layoutStones([note(1), note(2), note(3)]);
    const b = layoutStones([note(3), note(1), note(2)]);
    expect(a).toEqual(b);
  });

  it("keeps the newest notes, drops the oldest, newest on top", () => {
    const inputs = Array.from({ length: MAX_STONES + 4 }, (_, i) => note(i));
    const { stones } = layoutStones(inputs);
    expect(stones).toHaveLength(MAX_STONES);
    const newest = `note-${MAX_STONES + 3}`;
    expect(stones[stones.length - 1]).toMatchObject({ id: newest, top: true });
    expect(stones.filter((s) => s.top)).toHaveLength(1);
    expect(stones.map((s) => s.id)).not.toContain("note-0");
    // Top of the pile has the smallest y.
    for (let i = 1; i < stones.length; i += 1) expect(stones[i].y).toBeLessThan(stones[i - 1].y);
  });

  it("keeps every stone inside the canvas, with sane size, tilt and shade", () => {
    const { stones, height } = layoutStones(Array.from({ length: MAX_STONES }, (_, i) => note(i, i * 300)));
    for (const s of stones) {
      expect(s.x).toBeGreaterThanOrEqual(0);
      expect(s.x + s.w).toBeLessThanOrEqual(STACK_WIDTH + 1e-9);
      expect(s.w).toBeGreaterThanOrEqual(MIN_STONE_W);
      expect(s.h).toBeGreaterThanOrEqual(20);
      expect(s.h).toBeLessThanOrEqual(28);
      expect(Math.abs(s.rotate)).toBeLessThanOrEqual(3);
      expect(s.tone).toBeGreaterThanOrEqual(0);
      expect(s.tone).toBeLessThan(1);
      expect(s.y).toBeGreaterThanOrEqual(0);
      expect(s.y + s.h).toBeLessThanOrEqual(height + 1e-9);
    }
  });

  it("never lets a stone overhang the one below by more than a stable margin", () => {
    // Tiny notes at the bottom, a huge one on top.
    const inputs = [note(1, 10), note(2, 10), note(3, 5000)];
    const { stones } = layoutStones(inputs);
    for (let i = 1; i < stones.length; i += 1) expect(stones[i].w).toBeLessThanOrEqual(stones[i - 1].w + 18 + 1e-9);
  });

  it("makes bigger notes wider stones", () => {
    const small = layoutStones([note(1, 20)]).stones[0];
    const big = layoutStones([note(1, 3000)]).stones[0];
    expect(big.w).toBeGreaterThan(small.w);
  });

  it("adding a note on top leaves the stones below unchanged in size and tilt", () => {
    const before = layoutStones([note(1), note(2)]).stones;
    const after = layoutStones([note(1), note(2), note(3)]).stones;
    for (const s of before) {
      const same = after.find((a) => a.id === s.id)!;
      expect(same.rotate).toBe(s.rotate);
      expect(same.tone).toBe(s.tone);
      expect(same.h).toBe(s.h);
    }
  });
});
