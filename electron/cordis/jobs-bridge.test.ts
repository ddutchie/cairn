/**
 * Unit tests for the jobs bridge (dsh background jobs → session:projection).
 *
 * Fake jobs registry + capturing Electron window; no live model, no real ctx.
 * Proves: registry events re-list through the job's owner session (ownership
 * fence), summaries carry ownerSession, kill passes the remembered owner
 * session, settled jobs prune the kill map, mount is idempotent.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const sent: Array<{ channel: string; payload: unknown }> = [];

vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  BrowserWindow: {
    getAllWindows: () => [
      { isDestroyed: () => false, webContents: { send: (channel: string, payload: unknown) => { sent.push({ channel, payload }); } } },
    ],
  },
}));

import { mountJobsBridge, killJob, __resetJobsBridgeForTest } from "./jobs-bridge";

interface FakeSnap {
  id: string;
  kind: string;
  label: string;
  status: string;
  detail?: string;
  startedAt: number;
  finishedAt?: number;
  owner?: string;
}

type FakeEvent = { type: string; job?: FakeSnap; id?: string; owner?: string };

function makeRegistry() {
  let snaps: FakeSnap[] = [];
  const listeners: Array<(event: FakeEvent) => void> = [];
  const kills: Array<{ id: string; caller: unknown }> = [];
  const subscribe = vi.fn((_filter: unknown, fn: (event: FakeEvent) => void) => { listeners.push(fn); return () => {}; });
  return {
    setSnaps(next: FakeSnap[]) { snaps = next; },
    emit(event: FakeEvent) { for (const fn of listeners) fn(event); },
    kills,
    subscribe,
    events: { subscribe },
    list: vi.fn((_caller?: unknown) => snaps),
    kill: vi.fn((id: string, caller?: unknown) => {
      kills.push({ id, caller });
      return "requested" as const;
    }),
  };
}

/** Wait for exactly one new projection after `trigger` (emissions are async). */
async function expectOneProjection(trigger: () => void) {
  sent.length = 0;
  trigger();
  await vi.waitFor(() => expect(projections()).toHaveLength(1));
  return projections()[0]!;
}

function killCode(jobId: string, sessionId = "session-a"): string {
  try {
    killJob(jobId, sessionId);
    return "no-throw";
  } catch (err) {
    return (err as { code?: string }).code ?? "no-code";
  }
}

function projections() {
  return sent
    .filter((s) => s.channel === "session:projection")
    .map((s) => s.payload as { sessionId: string; kind: string; data: { ownerSession?: string; jobs: Array<{ id: string; status: string; ownerSession?: string }> } });
}

beforeEach(() => {
  sent.length = 0;
  __resetJobsBridgeForTest();
  vi.resetModules();
});

describe("mountJobsBridge", () => {
  it("emits the owner's visible set with ownerSession on change", async () => {
    const reg = makeRegistry();
    const job = { id: "subagent-1", kind: "subagent", label: "research", status: "running", startedAt: 1000, owner: "session-a" };
    reg.setSnaps([job, { id: "bash-1", kind: "bash", label: "ls", status: "running", startedAt: 2000, owner: "session-a" }]);
    mountJobsBridge({ jobs: reg } as never);

    const proj = await expectOneProjection(() => { reg.emit({ type: "registered", job }); });
    expect(proj.kind).toBe("jobs");
    expect(proj.sessionId).toBe("session-a");
    expect(proj.data.ownerSession).toBe("session-a");
    expect(proj.data.jobs.map((j) => j.id)).toEqual(["subagent-1", "bash-1"]);
    expect(proj.data.jobs[0]!.ownerSession).toBe("session-a");
    // Fence respected: re-listed through the owning session.
    expect(reg.list).toHaveBeenCalledWith("session-a");
  });

  it("ignores output chunks", async () => {
    const reg = makeRegistry();
    mountJobsBridge({ jobs: reg } as never);
    reg.emit({ type: "output", id: "bash-1", owner: "session-a" });
    await new Promise((r) => setTimeout(r, 20));
    expect(projections()).toHaveLength(0);
  });

  it("kill passes the owner session; settled jobs prune the kill map", async () => {
    const reg = makeRegistry();
    const job = { id: "subagent-1", kind: "subagent", label: "r", status: "running", startedAt: 1, owner: "session-a" };
    reg.setSnaps([job]);
    mountJobsBridge({ jobs: reg } as never);
    await expectOneProjection(() => { reg.emit({ type: "registered", job }); });

    killJob("subagent-1", "session-a");
    expect(reg.kills).toEqual([{ id: "subagent-1", caller: "session-a" }]);

    // Settle → re-emit prunes the map → kill now fails owner-unavailable.
    const settled = { ...job, status: "completed", finishedAt: 2 };
    reg.setSnaps([settled]);
    await expectOneProjection(() => { reg.emit({ type: "settled", job: settled }); });
    expect(killCode("subagent-1")).toBe("owner-unavailable");
  });

  it("kill from another session fails not-owner and never reaches the registry", async () => {
    const reg = makeRegistry();
    const job = { id: "subagent-1", kind: "subagent", label: "r", status: "running", startedAt: 1, owner: "session-a" };
    reg.setSnaps([job]);
    mountJobsBridge({ jobs: reg } as never);
    await expectOneProjection(() => { reg.emit({ type: "registered", job }); });

    expect(killCode("subagent-1", "session-b")).toBe("not-owner");
    expect(reg.kills).toEqual([]);
    expect(killCode("subagent-1", "session-a")).toBe("no-throw");
    expect(reg.kills).toEqual([{ id: "subagent-1", caller: "session-a" }]);
  });

  it("kill of an unowned job stays allowed (dock-visible everywhere)", async () => {
    const reg = makeRegistry();
    const job = { id: "bash-1", kind: "bash", label: "ls", status: "running", startedAt: 1 };
    reg.setSnaps([job]);
    mountJobsBridge({ jobs: reg } as never);
    const proj = await expectOneProjection(() => { reg.emit({ type: "registered", job }); });
    expect(proj.sessionId).toBe("jobs");

    expect(killCode("bash-1", "session-b")).toBe("no-throw");
    expect(reg.kills).toEqual([{ id: "bash-1", caller: undefined }]);
  });

  it("kill of an unknown job fails owner-unavailable", () => {
    const reg = makeRegistry();
    mountJobsBridge({ jobs: reg } as never);
    expect(killCode("nope")).toBe("owner-unavailable");
  });

  it("mount is idempotent per context", () => {
    const reg = makeRegistry();
    const ctx = { jobs: reg } as never;
    mountJobsBridge(ctx);
    mountJobsBridge(ctx);
    expect(reg.subscribe).toHaveBeenCalledTimes(1);
    expect(reg.subscribe).toHaveBeenCalledWith({ owners: "all" }, expect.any(Function));
  });

  it("missing ctx.jobs warns instead of throwing", () => {
    expect(() => mountJobsBridge({} as never)).not.toThrow();
  });
});
