/** withBackgroundTime: holds iOS background time for exactly as long as the work. */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  native: null as null | { begin: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> },
}));

vi.mock("expo", () => ({
  NativeModule: class {},
  requireOptionalNativeModule: () => h.native,
}));

beforeEach(() => {
  vi.resetModules();
  h.native = { begin: vi.fn(() => 7), end: vi.fn() };
});

describe("withBackgroundTime", () => {
  it("begins before the work and ends after it", async () => {
    const { withBackgroundTime } = await import("./index");
    const order: string[] = [];
    h.native!.begin.mockImplementation(() => (order.push("begin"), 7));
    h.native!.end.mockImplementation(() => void order.push("end"));
    expect(await withBackgroundTime("t", async () => (order.push("work"), 42))).toBe(42);
    expect(order).toEqual(["begin", "work", "end"]);
    expect(h.native!.end).toHaveBeenCalledWith(7);
  });

  it("ends even when the work throws", async () => {
    const { withBackgroundTime } = await import("./index");
    await expect(withBackgroundTime("t", async () => Promise.reject(new Error("x")))).rejects.toThrow("x");
    expect(h.native!.end).toHaveBeenCalledWith(7);
  });

  it("skips end when iOS refused the time", async () => {
    const { withBackgroundTime } = await import("./index");
    h.native!.begin.mockReturnValue(0);
    await withBackgroundTime("t", async () => {});
    expect(h.native!.end).not.toHaveBeenCalled();
  });

  it("holdBackgroundTime releases once, however often it's called", async () => {
    const { holdBackgroundTime } = await import("./index");
    const release = holdBackgroundTime("t");
    expect(h.native!.begin).toHaveBeenCalledWith("t");
    release();
    release();
    expect(h.native!.end).toHaveBeenCalledTimes(1);
  });

  it("just runs the work without the native module (Android, Expo Go)", async () => {
    h.native = null;
    const { withBackgroundTime } = await import("./index");
    expect(await withBackgroundTime("t", async () => "ok")).toBe("ok");
  });
});
