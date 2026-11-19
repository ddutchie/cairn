import { describe, it, expect } from "vitest";
import { FRESH_TAPS, UNLOCK_GAP_MS, UNLOCK_TAPS, registerUnlockTap, showPeopleSwitch, type UnlockTapState } from "./preview-unlock";

function tapN(n: number, start: UnlockTapState = FRESH_TAPS, t0 = 1000, gap = 300) {
  let s = start;
  let unlocked = false;
  for (let i = 0; i < n; i++) ({ state: s, unlocked } = registerUnlockTap(s, t0 + i * gap));
  return { s, unlocked };
}

describe("registerUnlockTap", () => {
  it("unlocks on the seventh quick tap, not before", () => {
    expect(tapN(UNLOCK_TAPS - 1).unlocked).toBe(false);
    expect(tapN(UNLOCK_TAPS).unlocked).toBe(true);
  });

  it("starts over after a pause", () => {
    const first = tapN(5);
    const resumed = registerUnlockTap(first.s, 1000 + 5 * 300 + UNLOCK_GAP_MS + 1);
    expect(resumed.state.count).toBe(1);
    expect(resumed.unlocked).toBe(false);
  });

  it("keeps counting while taps stay inside the gap", () => {
    const r = registerUnlockTap({ count: 3, at: 1000 }, 1000 + UNLOCK_GAP_MS);
    expect(r.state.count).toBe(4);
  });

  it("resets after unlocking so a later run starts clean", () => {
    expect(tapN(UNLOCK_TAPS).s).toEqual(FRESH_TAPS);
  });
});

describe("showPeopleSwitch", () => {
  it("shows nothing in a release build until unlocked or already on", () => {
    expect(showPeopleSwitch({ dev: false, unlocked: false, flagOn: false })).toBe(false);
    expect(showPeopleSwitch({ dev: false, unlocked: true, flagOn: false })).toBe(true);
    expect(showPeopleSwitch({ dev: false, unlocked: false, flagOn: true })).toBe(true);
    expect(showPeopleSwitch({ dev: true, unlocked: false, flagOn: false })).toBe(true);
  });
});
