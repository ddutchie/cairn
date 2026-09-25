/**
 * Unit tests for the opt-in schedule surface (session-local reminders).
 *
 * Proves, with fakes and no live model:
 *   - gating: `isScheduleEnabled()` reflects the persisted agent setting;
 *     disabled → the schedule service is NOT mounted; enabled → `ctx.schedule`
 *     is live and each root agent gets agent-scoped schedule_* tools;
 *   - `listSchedules` renders `ctx.schedule.list()` records in the
 *     schedule_list view shape (id/prompt/scheduledAt/kind/state) and returns
 *     [] when the service is off or the read fails.
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
import { ScheduleId, createAfterScheduleRecord } from "@deepseek-ai/dsh-schedule";
import { scopeOf } from "@deepseek-ai/dsh-scope";

beforeEach(() => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-schedule-"));
  setSessionRoot(path.join(tmp, "sessions"));
  setPluginsRoot(path.join(tmp, "plugins"));
});

function makeRecord(afterSeconds = 3600) {
  return createAfterScheduleRecord(ScheduleId("sched-1"), "Stretch and drink water", afterSeconds, Date.now(), "Stretch");
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
      expect((ctx as unknown as { schedule?: unknown }).schedule).toBeUndefined();
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
        const agent = (handle as { agent: { ctx?: { tools?: { get?: (name: string, scope?: unknown) => unknown } } } }).agent;
        // dsh-schedule 0.1.7: a host-wide service (storage-domain backed) that
        // attaches schedule_* tools to each root agent's own tool scope.
        expect((ctx as unknown as { schedule?: unknown }).schedule, "schedule service mounted").toBeDefined();
        // Registered in the agent's tool scope, so look it up with that scope key.
        await vi.waitFor(() => expect(agent.ctx?.tools?.get?.("schedule_create", scopeOf(agent.ctx as never)), "agent-scoped schedule tools").toBeDefined());
        const tools = (ctx as unknown as { tools?: { get?: (name: string) => unknown } }).tools;
        // Global tools stay untouched either way.
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
  it("returns [] when the schedule service is not mounted", async () => {
    await expect(listSchedules({} as never, "ghost")).resolves.toEqual([]);
  });

  it("returns [] when the service read fails", async () => {
    const fakeCtx = { schedule: { list: async () => { throw new Error("storage down"); } } };
    await expect(listSchedules(fakeCtx as never, "ghost")).resolves.toEqual([]);
  });

  it("renders the session's records in the schedule_list view shape", async () => {
    const seen: unknown[] = [];
    const fakeCtx = { schedule: { list: async (req: unknown) => { seen.push(req); return [makeRecord(3600)]; } } };
    const list = await listSchedules(fakeCtx as never, "live-session");
    expect(seen).toEqual([{ sessionId: "live-session" }]);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: "sched-1", prompt: "Stretch and drink water", kind: "after", state: "scheduled" });
    expect(typeof list[0]!.scheduledAt).toBe("string");
  });
});
