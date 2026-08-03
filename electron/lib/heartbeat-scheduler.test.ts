import { describe, it, expect, beforeEach, afterEach } from "vitest";
import BetterSqlite3 from "better-sqlite3";
import type Database from "better-sqlite3";
import { applySchema } from "../db/schema";
import { createWorkspace, createProject } from "../db/queries";
import { createAutomation, createAutomationRun, getAutomationById, listAutomationRuns, updateAutomationRun, type Automation, type AutomationRun } from "../db/automation-queries";
import { HeartbeatScheduler } from "./heartbeat-scheduler";

const T0 = new Date("2026-08-03T12:00:00Z");

let db: Database.Database;
let wsId: string;
let projectId: string;
let fired: Array<{ run: AutomationRun; automation: Automation }> = [];
let scheduler: HeartbeatScheduler | null = null;

async function flush(): Promise<void> {
  // Let the fire-and-forget spawn microtask complete.
  await new Promise((resolve) => setImmediate(resolve));
}

function makeAutomation(overrides: Record<string, unknown> = {}): { id: string } {
  const a = createAutomation(db, {
    workspaceId: wsId,
    projectId,
    name: "Test automation",
    instructions: "Do something useful.",
    scheduleKind: "every",
    scheduleExpr: "every 1 hour",
    nextRunAt: new Date(T0.getTime() - 60_000).toISOString(),
    ...overrides,
  } as never);
  return { id: a.id };
}

beforeEach(() => {
  db = new BetterSqlite3(":memory:");
  applySchema(db);
  wsId = "ws-1";
  projectId = "proj-1";
  createWorkspace(db, { id: wsId, name: "Workspace" });
  createProject(db, { id: projectId, workspaceId: wsId, name: "Project" });
  fired = [];
});

afterEach(() => {
  scheduler?.stop();
  scheduler = null;
});

function makeScheduler(runnerOverride?: (run: AutomationRun, automation: Automation) => Promise<void>): HeartbeatScheduler {
  scheduler = new HeartbeatScheduler({
    dbGetter: () => db,
    now: () => T0.getTime(),
    tickMs: 60_000,
    runner: runnerOverride ?? (async (run, automation) => {
      fired.push({ run, automation });
      // The runner owns the terminal status.
      updateAutomationRun(db, run.id, { status: "done", finishedAt: new Date().toISOString() });
    }),
  });
  return scheduler;
}

describe("HeartbeatScheduler", () => {
  it("fires due automations once (run-once catch-up) and advances next_run_at", async () => {
    makeAutomation();
    const s = makeScheduler();
    await s.tick();
    await flush();

    expect(fired.length).toBe(1);
    expect(fired[0].run.status).toBe("running");
    // Runner resolved → scheduler marks done.
    const runs = listAutomationRuns(db, fired[0].automation.id);
    expect(runs[0].status).toBe("done");
    // next_run_at advanced past the fire time.
    const a = getAutomationById(db, fired[0].automation.id)!;
    expect(new Date(a.nextRunAt).getTime()).toBeGreaterThan(T0.getTime());
  });

  it("does not re-fire an automation that is still in flight (skip-on-overlap)", async () => {
    const { id } = makeAutomation();
    // Simulate a previous fire still running.
    createAutomationRun(db, id, "running");
    const s = makeScheduler();
    await s.tick();
    await flush();

    expect(fired.length).toBe(0);
    expect(listAutomationRuns(db, id).length).toBe(1); // only the seeded one
  });

  it("does not fire when max_runs is reached (disables the automation)", async () => {
    const { id } = makeAutomation({ maxRuns: 2, runCount: 2 });
    const s = makeScheduler();
    await s.tick();
    await flush();

    expect(fired.length).toBe(0);
    expect(getAutomationById(db, id)!.enabled).toBe(false);
  });

  it("disables a 'once' automation whose time has passed", async () => {
    const { id } = makeAutomation({ scheduleKind: "once", scheduleExpr: "once 2020-01-01T00:00:00" });
    const s = makeScheduler();
    await s.tick();
    await flush();

    expect(fired.length).toBe(0);
    expect(getAutomationById(db, id)!.enabled).toBe(false);
  });

  it("records a run as error when the runner throws", async () => {
    const { id } = makeAutomation();
    const s = makeScheduler(async () => { throw new Error("boom"); });
    await s.tick();
    await flush();

    const runs = listAutomationRuns(db, id);
    expect(runs.length).toBe(1);
    expect(runs[0].status).toBe("error");
    expect(runs[0].error).toBe("boom");
  });

  it("fires multiple due automations independently", async () => {
    makeAutomation();
    makeAutomation({ name: "Second automation" });
    const s = makeScheduler();
    await s.tick();
    await flush();

    expect(fired.length).toBe(2);
  });

  it("ignores disabled automations", async () => {
    makeAutomation({ enabled: false });
    const s = makeScheduler();
    await s.tick();
    await flush();
    expect(fired.length).toBe(0);
  });

  it("start() runs an immediate catch-up tick then polls", async () => {
    makeAutomation();
    const s = makeScheduler();
    s.start();
    // Let the immediate catch-up tick + the fire-and-forget spawn complete.
    await new Promise((resolve) => setTimeout(resolve, 20));
    s.stop();
    expect(fired.length).toBe(1);
  });

  it("defers a due run until it's inside the active-hours window", async () => {
    const { id } = makeAutomation({ timezone: "UTC", activeHoursStart: "13:00", activeHoursEnd: "14:00" }); // T0 = 12:00Z
    const s = makeScheduler();
    await s.tick();
    await flush();
    expect(fired.length).toBe(0);
    // Still due — next_run_at unchanged so it fires once the window opens.
    const a = getAutomationById(db, id)!;
    expect(new Date(a.nextRunAt).getTime()).toBeLessThanOrEqual(T0.getTime());
  });

  it("fires when within the active-hours window", async () => {
    const { id } = makeAutomation({ timezone: "UTC", activeHoursStart: "09:00", activeHoursEnd: "18:00" }); // T0 = 12:00Z
    const s = makeScheduler();
    await s.tick();
    await flush();
    expect(fired.length).toBe(1);
    expect(listAutomationRuns(db, id).length).toBe(1);
  });

  it("ignores malformed active hours (treated as no gate)", async () => {
    const { id } = makeAutomation({ activeHoursStart: "nope", activeHoursEnd: "18:00" });
    const s = makeScheduler();
    await s.tick();
    await flush();
    expect(fired.length).toBe(1);
    expect(listAutomationRuns(db, id).length).toBe(1);
  });
});
