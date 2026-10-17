import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStreamingStore } from "./streaming-store";

describe("createStreamingStore", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_000_000); });
  afterEach(() => { vi.useRealTimers(); });

  it("set notifies subscribers immediately and unsubscribes cleanly", () => {
    const s = createStreamingStore();
    const fn = vi.fn();
    const off = s.subscribe(fn);
    s.set("a");
    expect(s.get()).toBe("a");
    expect(fn).toHaveBeenCalledTimes(1);
    off();
    s.set("ab");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("push emits the first value at once, then throttles with a trailing edge", () => {
    const s = createStreamingStore(33);
    const fn = vi.fn();
    s.subscribe(fn);
    s.push("a");
    expect(s.get()).toBe("a");
    s.push("ab");
    s.push("abc");
    expect(s.get()).toBe("a");
    vi.advanceTimersByTime(33);
    expect(s.get()).toBe("abc");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("flush applies the pending value without waiting", () => {
    const s = createStreamingStore(33);
    s.push("a");
    s.push("ab");
    s.flush();
    expect(s.get()).toBe("ab");
    vi.advanceTimersByTime(100);
    expect(s.get()).toBe("ab");
  });

  it("reset clears text and cancels pending pushes", () => {
    const s = createStreamingStore(33);
    s.push("a");
    s.push("ab");
    s.reset();
    vi.advanceTimersByTime(100);
    expect(s.get()).toBe("");
  });

  it("does not notify when the value is unchanged", () => {
    const s = createStreamingStore();
    const fn = vi.fn();
    s.subscribe(fn);
    s.set("x");
    s.set("x");
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
