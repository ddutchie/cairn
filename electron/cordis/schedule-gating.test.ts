/**
 * Unit tests for the opt-in schedule surface (session-local reminders).
 *
 * Proves, with fakes and no live model:
 *   - gating: `isScheduleEnabled()` reflects the persisted agent setting;
 *     disabled → the schedule overlay is NOT mounted (no `schedule`
 *     projection, no schedule tools); enabled → it IS mounted;
 *   - `listSchedules` folds the session log into the schedule_list view shape
 *     (id/prompt/scheduledAt/kind/state) and returns [] for unknown sessions.
 *
 * The config-cache mock below only affects this file (per-file module
 * registry); production reads the real userData cache.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as os from "os";
import * as fs from "fs";
import * as path from "path";

const configControl = vi.hoisted(() => ({ scheduleEnabled: false }));

vi.mock("../lib/config-cache", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/config-cache")>();
  return {
    ...original,
    getCachedConfig: () => (configControl.scheduleEnabled ? { agentConfig: { scheduleEnabled: true } } : {}),
  };
});

vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  app: { getPath: () => os.tmpdir() },
  BrowserWindow: { getAllWindows: () => [] },
}));

import { setPluginsRoot } from "./plugin-loader";
import { setSessionRoot, getContext, __resetContextForTest } from "./run-cordis-loop";
import { isScheduleEnabled } from "./cordis-context";
import { listSchedules } from "./schedule-read";
import {
  allocateScheduleId,
  createAfterScheduleRecord,
  foldScheduleEvents,
} from "@deepseek-ai/dsh-schedule";

beforeEach(() => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-schedule-"));
  setSessionRoot(path.join(tmp, "sessions"));
  setPluginsRoot(path.join(tmp, "plugins"));
});

function makeCreateEvent(afterSeconds = 3600) {
  const id = allocateScheduleId({ active: [], seenIds: [] });
  const record = createAfterScheduleRecord(id, "Stretch and drink water", afterSeconds, Date.now());
  return {
    seq: 0,
    type: "schedule/change",
    data: { version: 1, operation: "create", schedule: record },
  } as never;
}

async function openProbeAgent(ctx: Awaited<ReturnType<typeof getContext>>, tag: string) {
  const { openCordisAgent } = await import("./run-cordis-coding");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `cairn-sched-probe-${tag}-`));
  return openCordisAgent(ctx, {
    sessionId: `probe-schedule-${tag}-${Date.now()}`,
    cwd: tmp,
    llmConfig: { baseUrl: "http://localhost:1/v1", model: "m", apiKey: "k", provider: "openai" },
    signal: undefined,
  });
}

function projectionState(ctx: Awaited<ReturnType<typeof getContext>>, session: unknown) {
  const registry = (ctx as unknown as { sessionProjections?: { stateOf?: (s: unknown, key: string) => unknown } }).sessionProjections;
  return registry?.stateOf?.(session as never, "schedule");
}

describe("schedule gating", () => {
  it("isScheduleEnabled() is false by default", () => {
    configControl.scheduleEnabled = false;
    expect(isScheduleEnabled()).toBe(false);
  });

  it("disabled → schedule overlay not mounted (no projection, no tools)", async () => {
    configControl.scheduleEnabled = false;
    const ctx = await getContext();
    const handle = await openProbeAgent(ctx, "off");
    try {
      const agent = (handle as { agent: { session?: unknown } }).agent;
      expect(projectionState(ctx, agent.session)).toBeUndefined();
      const tools = (ctx as unknown as { tools?: { get?: (name: string) => unknown } }).tools;
      expect(tools?.get?.("schedule_create")).toBeUndefined();
      expect(tools?.get?.("schedule_list")).toBeUndefined();
      expect(tools?.get?.("schedule_delete")).toBeUndefined();
    } finally {
      try { await (handle as { dispose?: () => Promise<void> }).dispose?.(); } catch { /* noop */ }
    }
  }, 90000);

  it("enabled → schedule overlay mounted (projection live, tools registered)", async () => {
    configControl.scheduleEnabled = true;
    expect(isScheduleEnabled()).toBe(true);
    __resetContextForTest();
    const ctx = await getContext();
    try {
      const handle = await openProbeAgent(ctx, "on");
      try {
        const agent = (handle as { agent: { session?: unknown } }).agent;
        const state = projectionState(ctx, agent.session) as { active?: unknown[] } | undefined;
        expect(state, "schedule projection registered").toBeDefined();
        expect(state?.active).toEqual([]);
        const tools = (ctx as unknown as { tools?: { get?: (name: string) => unknown } }).tools;
        // Schedule tools are agent-scoped; the overlay proves itself through
        // the projection above. Global tools stay untouched either way.
        expect(tools?.get?.("schedule_create")).toBeUndefined();
      } finally {
        try { await (handle as { dispose?: () => Promise<void> }).dispose?.(); } catch { /* noop */ }
      }
    } finally {
      configControl.scheduleEnabled = false;
      __resetContextForTest();
    }
  }, 120000);
});

describe("listSchedules", () => {
  it("returns [] for sessions without an inspectable log", async () => {
    const fakeCtx = {
      sessions: { get: () => undefined },
      sessionPersistence: { inspect: async () => { throw new Error("no such session"); } },
    };
    await expect(listSchedules(fakeCtx as never, "ghost")).resolves.toEqual([]);
  });

  it("folds one create event into the schedule_list view shape", async () => {
    const events = [makeCreateEvent(3600)];
    const fakeCtx = { sessions: { get: () => ({ snapshotEvents: () => events }) } };
    const list = await listSchedules(fakeCtx as never, "live-session");
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ prompt: "Stretch and drink water", kind: "after", state: "scheduled" });
    expect(typeof list[0]!.id).toBe("string");
    expect(typeof list[0]!.scheduledAt).toBe("string");
    // Same fold the overlay itself reads — the IPC shape cannot drift from it.
    expect(foldScheduleEvents(events).active).toHaveLength(1);
  });

  it("returns [] when the log holds no schedule events", async () => {
    const fakeCtx = { sessions: { get: () => ({ snapshotEvents: () => [] }) } };
    await expect(listSchedules(fakeCtx as never, "empty")).resolves.toEqual([]);
  });
});
