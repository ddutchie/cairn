import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createDeltaBatcher } from "./delta-batcher";

describe("createDeltaBatcher", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("coalesces rapid pushes into a single emit after the flush window", () => {
    const emit = vi.fn();
    const batcher = createDeltaBatcher(emit, 50);

    batcher.push("hel");
    batcher.push("lo ");
    batcher.push("world");

    expect(emit).not.toHaveBeenCalled(); // nothing emitted yet

    vi.advanceTimersByTime(50);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith("hello world");
  });

  it("emits in batches as the stream continues, preserving order", () => {
    const emit = vi.fn();
    const batcher = createDeltaBatcher(emit, 50);

    batcher.push("a");
    vi.advanceTimersByTime(50);
    batcher.push("b");
    vi.advanceTimersByTime(50);
    batcher.push("c");
    batcher.push("d");
    vi.advanceTimersByTime(50);

    expect(emit.mock.calls.map((c) => c[0])).toEqual(["a", "b", "cd"]);
  });

  it("flush() emits the remaining buffer immediately and clears the timer", () => {
    const emit = vi.fn();
    const batcher = createDeltaBatcher(emit, 50);

    batcher.push("trailing");
    batcher.flush();

    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith("trailing");

    // The pending timer must be cancelled — advancing time emits nothing more.
    vi.advanceTimersByTime(50);
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it("flush() with an empty buffer emits nothing", () => {
    const emit = vi.fn();
    const batcher = createDeltaBatcher(emit, 50);
    batcher.flush();
    expect(emit).not.toHaveBeenCalled();
  });
});
