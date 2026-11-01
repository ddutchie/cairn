/** Auto-sync scheduler: debounced post-write sync, and the flush on background. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  appStateListener: null as ((s: string) => void) | null,
  writeListener: null as (() => void) | null,
  syncNow: vi.fn(),
  pending: 0,
}));

vi.mock("react-native", () => ({
  AppState: {
    currentState: "active",
    addEventListener: (_: string, fn: (s: string) => void) => {
      h.appStateListener = fn;
      return { remove: () => { h.appStateListener = null; } };
    },
  },
}));
vi.mock("./sync", () => ({ syncNow: h.syncNow, pendingCount: () => h.pending }));
vi.mock("@/db/queries", () => ({ conflictCount: () => 0 }));
vi.mock("./write-signal", () => ({
  onLocalWrite: (fn: () => void) => {
    h.writeListener = fn;
    return () => { h.writeListener = null; };
  },
}));
vi.mock("@/db", () => ({ setActiveSource: () => {}, getActiveSource: () => "ws1" }));
vi.mock("@/dev/demo-seed", () => ({ isDemoSource: () => false, openDemoWorkspace: () => {} }));

const { startAutoSync, stopAutoSync } = await import("./controller");

const OK = { drained: 0, peerOpsApplied: 0, peerOpsRead: 0, conflictCopies: 0, connected: true };

beforeEach(() => {
  vi.useFakeTimers();
  h.syncNow.mockReset().mockResolvedValue(OK);
  h.pending = 0;
  startAutoSync();
});
afterEach(() => {
  stopAutoSync();
  vi.useRealTimers();
});

describe("sync controller", () => {
  it("coalesces a burst of writes into one debounced sync", async () => {
    await vi.advanceTimersByTimeAsync(1_300); // let the launch sync run
    h.syncNow.mockClear();
    h.writeListener?.();
    h.writeListener?.();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.syncNow).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(600);
    expect(h.syncNow).toHaveBeenCalledTimes(1);
  });

  it("flushes a pending post-write sync straight away when the app backgrounds", async () => {
    await vi.advanceTimersByTimeAsync(1_300);
    h.syncNow.mockClear();
    h.writeListener?.();
    h.appStateListener?.("background");
    await vi.advanceTimersByTimeAsync(0);
    expect(h.syncNow).toHaveBeenCalledTimes(1);
    // The debounce was cancelled, so it doesn't fire a second sync later.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.syncNow).toHaveBeenCalledTimes(1);
  });

  it("syncs on background when earlier writes are still unsynced", async () => {
    await vi.advanceTimersByTimeAsync(1_300);
    h.syncNow.mockClear();
    h.pending = 3;
    h.appStateListener?.("background");
    await vi.advanceTimersByTimeAsync(0);
    expect(h.syncNow).toHaveBeenCalledTimes(1);
  });

  it("does nothing on background when there is nothing to send", async () => {
    await vi.advanceTimersByTimeAsync(1_300);
    h.syncNow.mockClear();
    h.appStateListener?.("background");
    await vi.advanceTimersByTimeAsync(0);
    expect(h.syncNow).not.toHaveBeenCalled();
  });
});
