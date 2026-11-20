import { describe, it, expect, beforeEach } from "vitest";
import { clearProfileWrites, latestProfileValue, noteProfileWrite } from "./recent-profile-writes";

beforeEach(clearProfileWrites);

describe("recent profile writes", () => {
  it("prefers a value just saved over the stale one in the list", () => {
    expect(latestProfileValue("p", "timezone", undefined, 0)).toBeUndefined();
    noteProfileWrite("p", "timezone", "Europe/London", 1000);
    // The list still says "empty": the location save must see the zone just saved.
    expect(latestProfileValue("p", "timezone", undefined, 2000)).toBe("Europe/London");
  });

  it("treats a cleared value as empty even when the list still has it", () => {
    noteProfileWrite("p", "timezone", null, 1000);
    expect(latestProfileValue("p", "timezone", "Europe/London", 2000)).toBeUndefined();
  });

  it("keeps people and fields apart, and falls back to the list once the entry is old", () => {
    noteProfileWrite("p", "timezone", "Europe/London", 1000);
    expect(latestProfileValue("q", "timezone", undefined, 2000)).toBeUndefined();
    expect(latestProfileValue("p", "location", undefined, 2000)).toBeUndefined();
    expect(latestProfileValue("p", "timezone", "Asia/Tokyo", 1000 + 11_000)).toBe("Asia/Tokyo");
  });
});
