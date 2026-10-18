import { describe, expect, it } from "vitest";
import { CANCEL_DX, HOLD_MS, onPressIn, onPressOut } from "./gesture";
import { applyResult, buildContextualStrings, mergeDictation, normalizeLevel } from "./merge";

describe("mergeDictation", () => {
  it("joins with one space, none after trailing whitespace", () => {
    expect(mergeDictation("hello", "world")).toBe("hello world");
    expect(mergeDictation("hello ", "world")).toBe("hello world");
    expect(mergeDictation("line one\n", "line two")).toBe("line one\nline two");
  });
  it("handles empty sides", () => {
    expect(mergeDictation("", "  spoken ")).toBe("spoken");
    expect(mergeDictation("typed", "   ")).toBe("typed");
    expect(mergeDictation("", "")).toBe("");
  });
});

describe("applyResult", () => {
  it("shows interim results without committing them", () => {
    const a = applyResult("", "buy mi", false);
    expect(a).toEqual({ committed: "", spoken: "buy mi" });
    const b = applyResult(a.committed, "buy milk", false);
    expect(b).toEqual({ committed: "", spoken: "buy milk" });
  });
  it("commits a final and builds the next phrase on top (Android continuous)", () => {
    const first = applyResult("", "buy milk", true);
    expect(first).toEqual({ committed: "buy milk", spoken: "buy milk" });
    const second = applyResult(first.committed, "and eggs", false);
    expect(second).toEqual({ committed: "buy milk", spoken: "buy milk and eggs" });
    expect(applyResult(second.committed, "and eggs", true).committed).toBe("buy milk and eggs");
  });
  it("takes one cumulative final as the whole text (iOS)", () => {
    expect(applyResult("", "buy milk and eggs", true)).toEqual({ committed: "buy milk and eggs", spoken: "buy milk and eggs" });
  });
});

describe("buildContextualStrings", () => {
  it("trims, dedupes ignoring case, drops empties and long entries, keeps order", () => {
    const out = buildContextualStrings(["  Garden   Planner ", "garden planner", "", "x".repeat(80), "Lisbon"]);
    expect(out).toEqual(["Garden Planner", "Lisbon"]);
  });
  it("caps the list", () => {
    const many = Array.from({ length: 300 }, (_, i) => `term ${i}`);
    expect(buildContextualStrings(many)).toHaveLength(100);
    expect(buildContextualStrings(many, 5)).toHaveLength(5);
  });
});

describe("normalizeLevel", () => {
  it("maps 0–10 to 0–1 and treats silence and junk as 0", () => {
    expect(normalizeLevel(5)).toBe(0.5);
    expect(normalizeLevel(10)).toBe(1);
    expect(normalizeLevel(25)).toBe(1);
    expect(normalizeLevel(-2)).toBe(0);
    expect(normalizeLevel(NaN)).toBe(0);
  });
});

describe("mic gesture", () => {
  it("starts listening on press from idle, not when already listening", () => {
    expect(onPressIn("idle")).toBe("start");
    expect(onPressIn("toggled")).toBe("none");
  });
  it("a quick tap from idle keeps listening (toggled on)", () => {
    expect(onPressOut("idle", HOLD_MS - 1, 0)).toEqual({ mode: "toggled", action: "none" });
  });
  it("holding then releasing stops (hold-to-talk)", () => {
    expect(onPressOut("idle", HOLD_MS, 0)).toEqual({ mode: "idle", action: "stop" });
    expect(onPressOut("idle", 3000, -10)).toEqual({ mode: "idle", action: "stop" });
  });
  it("a press that began while toggled on stops, however long", () => {
    expect(onPressOut("toggled", 50, 0)).toEqual({ mode: "idle", action: "stop" });
    expect(onPressOut("toggled", 2000, 0)).toEqual({ mode: "idle", action: "stop" });
  });
  it("sliding left past the threshold cancels in either mode, even a quick press", () => {
    expect(onPressOut("idle", 2000, CANCEL_DX)).toEqual({ mode: "idle", action: "cancel" });
    expect(onPressOut("idle", 50, CANCEL_DX - 20)).toEqual({ mode: "idle", action: "cancel" });
    expect(onPressOut("toggled", 100, CANCEL_DX)).toEqual({ mode: "idle", action: "cancel" });
  });
  it("a small leftward drift does not cancel", () => {
    expect(onPressOut("idle", 2000, CANCEL_DX + 1).action).toBe("stop");
  });
});
