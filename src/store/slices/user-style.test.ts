/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, afterEach } from "vitest";
import { createUserStyleSlice } from "./user-style";

function setup(electron: any) {
  let state: any = {};
  const mockSet = (updater: any) => {
    const next = typeof updater === "function" ? updater(state) : updater;
    state = { ...state, ...next };
  };
  const mockGet = () => state;
  const slice = createUserStyleSlice(mockSet, mockGet, {} as any);
  state = { ...state, ...slice };
  (globalThis as any).window = { electron };
  return { get: () => state };
}

afterEach(() => {
  delete (globalThis as any).window;
  vi.restoreAllMocks();
});

const row = {
  id: "global",
  persona: { name: "Gerard", role: "Engineering lead" },
  fullGuide: "## 1. Voice in one line\nWarm.",
  cheatsheet: "Warm.",
  source: "guided",
  updatedAt: "2026-08-11T00:00:00Z",
};

describe("createUserStyleSlice", () => {
  it("fetchUserStyle loads the row into state", async () => {
    const { get } = setup({ getUserStyle: vi.fn(async () => row) });
    await get().fetchUserStyle();
    expect(get().userStyle).toEqual(row);
  });

  it("saveUserStyle stores the returned row", async () => {
    const save = vi.fn(async () => row);
    const { get } = setup({ saveUserStyle: save });
    const saved = await get().saveUserStyle({ source: "guided", fullGuide: "g", cheatsheet: "c" });
    expect(saved).toEqual(row);
    expect(get().userStyle).toEqual(row);
    expect(save).toHaveBeenCalledWith({ source: "guided", fullGuide: "g", cheatsheet: "c" });
  });

  it("clearUserStyle nulls state", async () => {
    const { get } = setup({ clearUserStyle: vi.fn(async () => ({ ok: true })) });
    await get().clearUserStyle();
    expect(get().userStyle).toBeNull();
  });
});
