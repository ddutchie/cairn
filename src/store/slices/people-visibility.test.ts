/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * The People view is hidden by default: hidden once per install on first run
 * (so it changes nobody's sidebar or ⌘3–⌘9), and unreachable while the
 * `feature.people` flag is off.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { applyFirstRunHiddenViews, createUISlice, FIRST_RUN_HIDDEN_VIEWS } from "./ui";

vi.mock("@/lib/storage", () => ({
  storage: { get: vi.fn(() => null), set: vi.fn(), delete: vi.fn(), clear: vi.fn() },
}));

describe("applyFirstRunHiddenViews", () => {
  it("hides People on a fresh install and records it", () => {
    expect(FIRST_RUN_HIDDEN_VIEWS).toContain("people");
    const r = applyFirstRunHiddenViews(null, null);
    expect(r.hidden).toContain("people");
    expect(r.applied).toContain("people");
    expect(r.changed).toBe(true);
  });

  it("keeps an existing user's hidden views and adds People once", () => {
    const r = applyFirstRunHiddenViews(["board", "usage"], []);
    expect(r.hidden).toEqual(["board", "usage", "people"]);
    expect(r.changed).toBe(true);
  });

  it("does not hide People again after the user turned it on", () => {
    const first = applyFirstRunHiddenViews([], null);
    const shown = first.hidden.filter((v) => v !== "people"); // the user shows it
    const again = applyFirstRunHiddenViews(shown, first.applied);
    expect(again.hidden).not.toContain("people");
    expect(again.changed).toBe(false);
  });
});

describe("setView gate", () => {
  let state: any;
  beforeEach(() => {
    state = {};
    const set = (u: any) => { state = { ...state, ...(typeof u === "function" ? u(state) : u) }; };
    state = { ...createUISlice(set, () => state, {} as any), peopleEnabled: false, calendarScope: "project" };
  });

  it("starts with People hidden before any hydration", () => {
    expect(state.hiddenViews.has("people")).toBe(true);
  });

  it("refuses the People view while the flag is off", () => {
    state.setView("people");
    expect(state.activeView).toBe("overview");
  });

  it("opens the People view once the flag is on", () => {
    state.peopleEnabled = true;
    state.setView("people");
    expect(state.activeView).toBe("people");
  });
});
