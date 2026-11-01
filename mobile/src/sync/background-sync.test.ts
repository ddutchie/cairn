/** Background catch-up sync: when it syncs, when it skips, and scheduling. */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  defined: new Map<string, () => Promise<unknown>>(),
  registered: [] as { name: string; options: unknown }[],
  status: 2,
  alreadyRegistered: false,
  hasSource: true,
  active: "ws1" as string | null,
  requestSync: vi.fn(async () => {}),
  state: "idle" as "idle" | "offline",
  lastResult: null as { connected: boolean; peerOpsApplied: number } | null,
  refreshWidgets: vi.fn(),
}));

vi.mock("expo-background-task", () => ({
  BackgroundTaskResult: { Success: 1, Failed: 2 },
  BackgroundTaskStatus: { Restricted: 1, Available: 2 },
  getStatusAsync: async () => h.status,
  registerTaskAsync: async (name: string, options: unknown) => void h.registered.push({ name, options }),
}));
vi.mock("expo-task-manager", () => ({
  defineTask: (name: string, fn: () => Promise<unknown>) => void h.defined.set(name, fn),
  isTaskRegisteredAsync: async () => h.alreadyRegistered,
}));
vi.mock("@/db", () => ({ initDatabase: () => ({ hasSource: h.hasSource }), getActiveSource: () => h.active }));
vi.mock("@/dev/demo-seed", () => ({ isDemoSource: (ws: string | null) => ws === "demo" }));
vi.mock("@/widgets", () => ({ refreshWidgets: h.refreshWidgets }));
vi.mock("./controller", () => ({ requestSync: h.requestSync, getSnapshot: () => ({ state: h.state, lastResult: h.lastResult }) }));

const { BACKGROUND_SYNC_TASK, runBackgroundSync, registerBackgroundSync } = await import("./background-sync");

beforeEach(() => {
  h.registered.length = 0;
  h.status = 2;
  h.alreadyRegistered = false;
  h.hasSource = true;
  h.active = "ws1";
  h.state = "idle";
  h.lastResult = null;
  h.requestSync.mockReset().mockResolvedValue(undefined);
  h.refreshWidgets.mockReset();
});

describe("runBackgroundSync", () => {
  it("is defined as a task at module load", () => {
    expect(h.defined.get(BACKGROUND_SYNC_TASK)).toBe(runBackgroundSync);
  });

  it("syncs the active source and refreshes widgets when peer edits landed", async () => {
    h.lastResult = { connected: true, peerOpsApplied: 3 };
    expect(await runBackgroundSync()).toBe(1);
    expect(h.requestSync).toHaveBeenCalledWith("background-task");
    expect(h.refreshWidgets).toHaveBeenCalledTimes(1);
  });

  it("leaves widgets alone after a quiet sync", async () => {
    h.lastResult = { connected: true, peerOpsApplied: 0 };
    await runBackgroundSync();
    expect(h.refreshWidgets).not.toHaveBeenCalled();
  });

  it("skips with no source selected, or the sample workspace", async () => {
    h.hasSource = false;
    expect(await runBackgroundSync()).toBe(1);
    h.hasSource = true;
    h.active = "demo";
    expect(await runBackgroundSync()).toBe(1);
    expect(h.requestSync).not.toHaveBeenCalled();
  });

  it("reports failure when the sync throws", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    h.requestSync.mockRejectedValueOnce(new Error("boom"));
    expect(await runBackgroundSync()).toBe(2);
  });

  it("reports failure when the controller ended the sync offline", async () => {
    h.state = "offline";
    h.lastResult = { connected: true, peerOpsApplied: 3 };
    expect(await runBackgroundSync()).toBe(2);
    expect(h.refreshWidgets).not.toHaveBeenCalled();
  });
});

describe("registerBackgroundSync", () => {
  it("schedules once when background tasks are available", async () => {
    await registerBackgroundSync();
    expect(h.registered).toEqual([{ name: BACKGROUND_SYNC_TASK, options: { minimumInterval: 30 } }]);
  });

  it("does nothing when unavailable or already registered", async () => {
    h.status = 1;
    await registerBackgroundSync();
    h.status = 2;
    h.alreadyRegistered = true;
    await registerBackgroundSync();
    expect(h.registered).toEqual([]);
  });
});
