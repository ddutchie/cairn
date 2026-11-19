/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * People is an ordinary, visible view since 3.3.0. It was hidden on every
 * install while it was a preview, so those installs show it once.
 */
import { describe, it, expect, vi } from "vitest";
import { createUISlice, FIRST_RUN_HIDDEN_VIEWS, showPeopleOnce } from "./ui";

vi.mock("@/lib/storage", () => ({
  storage: { get: vi.fn(() => null), set: vi.fn(), delete: vi.fn(), clear: vi.fn() },
}));

describe("showPeopleOnce", () => {
  it("un-hides People for an install that hid it as a preview, and records it", () => {
    const r = showPeopleOnce(["board", "people", "usage"], null);
    expect(r.hidden).toEqual(["board", "usage"]);
    expect(r.changed).toBe(true);
  });

  it("leaves a later choice to hide People alone", () => {
    const r = showPeopleOnce(["people"], true);
    expect(r.hidden).toEqual(["people"]);
    expect(r.changed).toBe(false);
  });

  it("handles a fresh install", () => {
    expect(showPeopleOnce(null, null)).toEqual({ hidden: [], changed: true });
  });
});

describe("defaults", () => {
  it("hides no view on first run", () => {
    expect(FIRST_RUN_HIDDEN_VIEWS).toEqual([]);
  });

  it("starts with People visible and opens the People view", () => {
    let state: any = {};
    const set = (u: any) => { state = { ...state, ...(typeof u === "function" ? u(state) : u) }; };
    state = { ...createUISlice(set, () => state, {} as any), calendarScope: "project" };
    expect(state.hiddenViews.has("people")).toBe(false);
    state.setView("people");
    expect(state.activeView).toBe("people");
  });
});
