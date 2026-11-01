/** Auto-sync scheduler: debounced post-write sync, and the flush on background. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  appStateListener: null as ((s: string) => void) | null,
  writeListener: null as (() => void) | null,
  syncNow: vi.fn(),
  pending: 0,
  backgroundTime: 0,
  released: 0,
  events: [] as string[],
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
vi.mock("@modules/background-time", () => {
  const holdBackgroundTime = () => {
    h.backgroundTime++;
    h.events.push("hold");
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      h.released++;
      h.events.push("release");
    };
  };
  return {
    holdBackgroundTime,
    withBackgroundTime: async (name: string, work: () => Promise<unknown>) => {
      const release = holdBackgroundTime();
      try {
        return await work();
      } finally {
        release();
      }
    },
  };
});
vi.mock("@/dev/demo-seed", () => ({ isDemoSource: () => false, openDemoWorkspace: () => {} }));

const { startAutoSync, stopAutoSync } = await import("./controller");

const OK = { drained: 0, peerOpsApplied: 0, peerOpsRead: 0, conflictCopies: 0, connected: true };

beforeEach(() => {
  vi.useFakeTimers();
  h.syncNow.mockReset().mockResolvedValue(OK);
  h.pending = 0;
  h.backgroundTime = 0;
  h.released = 0;
  h.events.length = 0;
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

  it("holds background time from the first write until its sync finishes", async () => {
    await vi.advanceTimersByTimeAsync(1_300);
    let finish!: (v: typeof OK) => void;
    h.syncNow.mockImplementationOnce(() => new Promise((r) => (finish = r)));
    h.writeListener?.();
    h.writeListener?.();
    expect(h.backgroundTime).toBe(1); // taken once, while still foregrounded
    await vi.advanceTimersByTimeAsync(1_600);
    expect(h.released).toBe(0); // sync still running
    finish(OK);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.released).toBe(1);
  });

  it("releases held background time on teardown", () => {
    h.writeListener?.();
    stopAutoSync();
    expect(h.events).toEqual(["hold", "release"]);
  });

  it("flushes a pending post-write sync straight away when the app backgrounds", async () => {
    await vi.advanceTimersByTimeAsync(1_300);
    h.syncNow.mockClear();
    h.writeListener?.();
    h.appStateListener?.("background");
    await vi.advanceTimersByTimeAsync(0);
    expect(h.syncNow).toHaveBeenCalledTimes(1);
    expect(h.backgroundTime).toBe(1); // the write's hold, not a second one
    expect(h.released).toBe(1);
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
