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
  removeFiles: vi.fn(async () => 2),
  forget: vi.fn(),
  icloud: true,
  active: "ws1",
  setActive: vi.fn(),
  forgotten: new Set<string>(),
  gate: null as Promise<void> | null,
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
vi.mock("@/db", () => ({
  setActiveSource: (ws: string) => { h.active = ws; h.setActive(ws); },
  getActiveSource: () => h.active,
  getDeviceId: () => "mobile_me",
  forgetSource: (ws: string) => { h.forget(ws); h.forgotten.add(ws); },
  isSourceForgotten: (ws: string) => h.forgotten.has(ws),
}));
vi.mock("@/notes/note-draft", () => ({ clearWorkspaceDrafts: () => {} }));
vi.mock("./folder", () => ({ getSyncFolderPath: async () => "folder", iCloudAvailable: async () => h.icloud }));
vi.mock("./fs-transport", () => ({ removeWorkspaceFromFolder: (...a: unknown[]) => (h.removeFiles as (...x: unknown[]) => Promise<number>)(...a) }));
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

const { startAutoSync, stopAutoSync, removeSource, onActiveSourceRemoved } = await import("./controller");

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

describe("removeSource", () => {
  beforeEach(() => {
    h.removeFiles.mockClear();
    h.forget.mockClear();
    h.setActive.mockClear();
    h.icloud = true;
    h.active = "ws1";
    h.forgotten.clear();
  });

  it("deletes the shared oplog files, then the local copy", async () => {
    const res = await removeSource("ws2");
    expect(h.removeFiles).toHaveBeenCalledWith("folder", "mobile_me", "ws2");
    expect(h.forget).toHaveBeenCalledWith("ws2");
    expect(res.deletedFromFolder).toBe(2);
    expect(h.setActive).not.toHaveBeenCalled(); // not the active one: nothing to switch
  });

  it("switches to the fallback when the active workspace is removed", async () => {
    await removeSource("ws1", "ws2");
    expect(h.setActive).toHaveBeenCalledWith("ws2");
  });

  it("returns to onboarding when the active workspace is removed and nothing is left", async () => {
    const cleared = vi.fn();
    const off = onActiveSourceRemoved(cleared);
    await removeSource("ws1");
    off();
    expect(cleared).toHaveBeenCalledTimes(1);
  });

  it("still removes the local copy when iCloud is unreachable", async () => {
    h.icloud = false;
    const res = await removeSource("ws2");
    expect(h.removeFiles).not.toHaveBeenCalled();
    expect(h.forget).toHaveBeenCalledWith("ws2");
    expect(res.deletedFromFolder).toBeNull();
  });

  it("keeps the local copy if the shared files can't be deleted", async () => {
    h.removeFiles.mockRejectedValueOnce(new Error("iCloud busy"));
    await expect(removeSource("ws2")).rejects.toThrow("iCloud busy");
    expect(h.forget).not.toHaveBeenCalled();
  });

  it("doesn't switch to a fallback that was removed meanwhile; returns to onboarding instead", async () => {
    const cleared = vi.fn();
    const off = onActiveSourceRemoved(cleared);
    h.forgotten.add("ws2"); // another removal got there first
    await removeSource("ws1", "ws2");
    off();
    expect(h.setActive).not.toHaveBeenCalled();
    expect(cleared).toHaveBeenCalledTimes(1);
  });

  it("runs overlapping removals one at a time", async () => {
    const order: string[] = [];
    let release!: () => void;
    h.removeFiles.mockImplementationOnce(async () => {
      order.push("a:start");
      await new Promise<void>((r) => { release = r; });
      order.push("a:end");
      return 1;
    });
    h.removeFiles.mockImplementationOnce(async () => {
      order.push("b:start");
      return 1;
    });
    const a = removeSource("ws1", "ws2");
    const b = removeSource("ws2");
    await vi.waitFor(() => expect(order).toEqual(["a:start"]));
    release();
    await Promise.all([a, b]);
    expect(order).toEqual(["a:start", "a:end", "b:start"]);
    // a finished first, so it switched to ws2 (still alive); b then removed it and cleared.
    expect(h.setActive).toHaveBeenCalledWith("ws2");
  });
});
