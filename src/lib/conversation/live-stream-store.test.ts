import { describe, expect, it, vi } from "vitest";
import { createLiveStreamStore } from "./live-stream-store";

describe("createLiveStreamStore", () => {
  it("starts empty and returns a stable snapshot until it changes", () => {
    const s = createLiveStreamStore();
    const a = s.get();
    expect(a).toEqual({ content: "", thought: "" });
    s.set("", "");
    expect(s.get()).toBe(a);
  });

  it("notifies on change only and replaces the snapshot identity", () => {
    const s = createLiveStreamStore();
    const fn = vi.fn();
    const off = s.subscribe(fn);
    s.set("hi", "");
    s.set("hi", "");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(s.get()).toEqual({ content: "hi", thought: "" });
    off();
    s.set("hi!", "");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("clearing returns to the shared empty snapshot", () => {
    const s = createLiveStreamStore();
    const empty = s.get();
    s.set("x", "y");
    s.set("", "");
    expect(s.get()).toBe(empty);
  });
});
