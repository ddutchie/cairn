import { describe, expect, it } from "vitest";
import { parseRemovalMarker, parseRemovalMarkerName, removalMarkerName, serializeRemovalMarker } from "./removal-marker";

describe("removal marker", () => {
  it("round-trips the filename, including ids with dashes", () => {
    for (const id of ["abc123", "-lead", "trail-", "a_b-c"]) {
      expect(parseRemovalMarkerName(removalMarkerName(id))).toBe(id);
    }
  });
  it("ignores unrelated files", () => {
    expect(parseRemovalMarkerName("oplog-d-ws.ndjson")).toBeNull();
    expect(parseRemovalMarkerName("removed-.json")).toBeNull();
    expect(parseRemovalMarkerName("removed-a/b.json")).toBeNull();
  });
  it("rejects unsafe ids", () => {
    expect(() => removalMarkerName("../x")).toThrow();
  });
  it("parses leniently", () => {
    const m = { workspaceId: "w", removedAt: "2026-01-01T00:00:00.000Z", deviceId: "desktop_x" };
    expect(parseRemovalMarker(serializeRemovalMarker(m), "w")).toEqual(m);
    expect(parseRemovalMarker("{partial", "w")).toEqual({ workspaceId: "w", removedAt: "", deviceId: "" });
  });
});
