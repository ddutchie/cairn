/**
 * Unit tests for the jobs bridge (dsh background jobs → session:projection).
 *
 * Fake jobs registry + capturing Electron window; no live model, no real ctx.
 * Proves: change/completion notifications re-list through the notifying owner
 * (ownership fence), summaries carry ownerSession, kill passes the stashed
 * owner, settled jobs prune the kill map, mount is idempotent.
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
  ownerSession?: string;
}

function makeRegistry() {
  let snaps: FakeSnap[] = [];
  const changed: Array<(owner: unknown) => void> = [];
  const done: Array<(snap: FakeSnap, owner: unknown) => void> = [];
  const kills: Array<{ id: string; caller: unknown }> = [];
  return {
    setSnaps(next: FakeSnap[]) { snaps = next; },
    changed,
    done,
    kills,
    list: vi.fn((caller?: unknown) => snaps),
    kill: vi.fn((id: string, caller?: unknown) => {
      kills.push({ id, caller });
      return "requested" as const;
    }),
    onJobsChanged: vi.fn((fn: (owner: unknown) => void) => { changed.push(fn); return () => {}; }),
    onJobDone: vi.fn((fn: (snap: FakeSnap, owner: unknown) => void) => { done.push(fn); return () => {}; }),
  };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Wait for exactly one new projection after `trigger` (emissions are async). */
async function expectOneProjection(trigger: () => void) {
  sent.length = 0;
  trigger();
  await vi.waitFor(() => expect(projections()).toHaveLength(1));
  return projections()[0]!;
}

function killCode(jobId: string): string {
  try {
    killJob(jobId);
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
    const owner = { id: "agent-1", session: { id: "session-a" } };
    reg.setSnaps([
      { id: "subagent-1", kind: "subagent", label: "research", status: "running", startedAt: 1000, ownerSession: "session-a" },
      { id: "bash-1", kind: "bash", label: "ls", status: "running", startedAt: 2000 },
    ]);
    mountJobsBridge({ jobs: reg } as never);

    const proj = await expectOneProjection(() => { reg.changed[0]?.(owner); });
    expect(proj.kind).toBe("jobs");
    expect(proj.sessionId).toBe("session-a");
    expect(proj.data.ownerSession).toBe("session-a");
    expect(proj.data.jobs.map((j) => j.id)).toEqual(["subagent-1", "bash-1"]);
    // Fence respected: re-listed through the notifying owner.
    expect(reg.list).toHaveBeenCalledWith(owner);
  });

  it("falls back to the agent session id when snapshots lack ownerSession", async () => {
    const reg = makeRegistry();
    const owner = { id: "agent-9", session: { id: "session-z" } };
    reg.setSnaps([{ id: "bash-2", kind: "bash", label: "x", status: "running", startedAt: 1 }]);
    mountJobsBridge({ jobs: reg } as never);

    const proj = await expectOneProjection(() => { reg.changed[0]?.(owner); });
    expect(proj.sessionId).toBe("session-z");
  });

  it("kill passes the stashed owner; settled jobs prune the kill map", async () => {
    const reg = makeRegistry();
    const owner = { id: "agent-1", session: { id: "session-a" } };
    reg.setSnaps([{ id: "subagent-1", kind: "subagent", label: "r", status: "running", startedAt: 1, ownerSession: "session-a" }]);
    mountJobsBridge({ jobs: reg } as never);
    await expectOneProjection(() => { reg.changed[0]?.(owner); });

    killJob("subagent-1");
    expect(reg.kills).toEqual([{ id: "subagent-1", caller: owner }]);

    // Settle → re-emit prunes the stash → kill now fails owner-unavailable.
    reg.setSnaps([{ id: "subagent-1", kind: "subagent", label: "r", status: "completed", startedAt: 1, finishedAt: 2, ownerSession: "session-a" }]);
    await expectOneProjection(() => { reg.done[0]?.({ id: "subagent-1", status: "completed" } as FakeSnap, owner); });
    expect(killCode("subagent-1")).toBe("owner-unavailable");
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
    expect(reg.onJobsChanged).toHaveBeenCalledTimes(1);
    expect(reg.onJobDone).toHaveBeenCalledTimes(1);
  });

  it("missing ctx.jobs warns instead of throwing", () => {
    expect(() => mountJobsBridge({} as never)).not.toThrow();
  });
});
