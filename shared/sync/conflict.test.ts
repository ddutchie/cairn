/**
 * Conflict-copy helper tests — verify the pure detection/cleanup logic matches
 * the id + title scheme the SyncEngine actually produces (see engine.ts
 * makeConflictCopy: id = `<orig>_conflict_<device>_<base36ts>`, title suffix
 * ` (conflicted copy — <device>)`).
 */

import { describe, it, expect } from "vitest";
import { inspectConflict, isConflictCopy, cleanConflictTitle } from "./conflict";

describe("conflict helpers", () => {
  const orig = "n1AbcDEF";
  const device = "mobile_5rrpiqngmr8aqd67";
  const ts = Date.now().toString(36);
  const copyId = `${orig}_conflict_${device}_${ts}`;
  const copyTitle = `My Note (conflicted copy — ${device})`;

  it("detects a conflict copy from the engine id scheme", () => {
    const info = inspectConflict(copyId, copyTitle);
    expect(info.isConflict).toBe(true);
    expect(info.originalId).toBe(orig);
    expect(info.deviceId).toBe(device);
    expect(isConflictCopy(copyId)).toBe(true);
  });

  it("treats a normal note as not-a-conflict", () => {
    expect(isConflictCopy("plainId123", "Just a note")).toBe(false);
    expect(inspectConflict("plainId123").originalId).toBeNull();
  });

  it("falls back to the title marker when the id is opaque", () => {
    const info = inspectConflict("opaque", copyTitle);
    expect(info.isConflict).toBe(true);
    expect(info.deviceId).toBe(device);
  });

  it("strips the conflicted-copy suffix for display", () => {
    expect(cleanConflictTitle(copyTitle)).toBe("My Note");
    expect(cleanConflictTitle("Untouched")).toBe("Untouched");
  });
});
