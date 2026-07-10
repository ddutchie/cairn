import { describe, it, expect } from "vitest";
import { resolveDateDrop, UNSCHEDULED_DROP_ID } from "./dnd";

describe("resolveDateDrop", () => {
  it("sets dueDate when dropped on a day key", () => {
    expect(resolveDateDrop("2026-07-01", { dueDate: undefined })).toEqual({ dueDate: "2026-07-01" });
    expect(resolveDateDrop("2026-07-01", { dueDate: "2026-06-10" })).toEqual({ dueDate: "2026-07-01" });
  });

  it("clears dueDate when dropped on the unscheduled tray", () => {
    expect(resolveDateDrop(UNSCHEDULED_DROP_ID, { dueDate: "2026-06-10" })).toEqual({ dueDate: undefined });
  });

  it("is a no-op when dropped on the card's current day", () => {
    expect(resolveDateDrop("2026-06-10", { dueDate: "2026-06-10" })).toBeNull();
  });

  it("is a no-op when an unscheduled card is dropped on the unscheduled tray", () => {
    expect(resolveDateDrop(UNSCHEDULED_DROP_ID, { dueDate: undefined })).toBeNull();
    expect(resolveDateDrop(UNSCHEDULED_DROP_ID, { dueDate: null })).toBeNull();
  });

  it("returns null for null/empty/invalid drop-target ids", () => {
    expect(resolveDateDrop(null, { dueDate: "2026-06-10" })).toBeNull();
    expect(resolveDateDrop(undefined, { dueDate: "2026-06-10" })).toBeNull();
    expect(resolveDateDrop("", { dueDate: "2026-06-10" })).toBeNull();
    expect(resolveDateDrop("not-a-date", { dueDate: "2026-06-10" })).toBeNull();
    expect(resolveDateDrop("2026-13-99-extra", { dueDate: undefined })).toBeNull();
  });
});
