/**
 * Unit tests for the goals surface (dsh-goal stack → renderer goal chip).
 *
 * Proves, with fakes and no live model:
 *   - the goal stack mounts in `getContext()` (ctx.goals, /goal command,
 *     get_goal/create_goal/update_goal tools);
 *   - the dsh `goal` projection shape folds as the chip expects (null before
 *     create, full wire view after a create event);
 *   - goal-bridge re-emits `goal/changed` as session:projection kind:"goal"
 *     with the renderer-safe wire shape (durable fields only — no
 *     process-local activation), and hides the chip (null) on clear.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as os from "os";
import * as fs from "fs";
import * as path from "path";
import { setPluginsRoot } from "./plugin-loader";
import { setSessionRoot, getContext } from "./run-cordis-loop";

const sent: Array<{ channel: string; payload: unknown }> = [];

vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  app: { getPath: () => os.tmpdir() },
  BrowserWindow: {
    getAllWindows: () => [
      { isDestroyed: () => false, webContents: { send: (channel: string, payload: unknown) => { sent.push({ channel, payload }); } } },
    ],
  },
}));

import { mountGoalBridge, toGoalWire, readGoalSnapshot } from "./goal-bridge";
import {
  GOAL_CHANGE_VERSION,
  applyGoalProjection,
  goalProjectionDefinition,
} from "@deepseek-ai/dsh-goal";

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-goal-"));
  setSessionRoot(path.join(tmp, "sessions"));
  setPluginsRoot(path.join(tmp, "plugins"));
  sent.length = 0;
});

function makeCreateEvent() {
  return {
    seq: 0,
    type: "goal/change",
    data: {
      kind: "goal/change",
      version: GOAL_CHANGE_VERSION,
      operation: "create",
      goal: { id: "goal-1", revision: 1, objective: "Ship the widget", phase: "active", maxGoalRounds: 5 },
      roundsStarted: 0,
      createdAt: 1000,
      updatedAt: 1000,
    },
  } as never;
}

describe("goal stack mount", () => {
  it("mounts ctx.goals, the /goal command, and the goal tools (no live model)", async () => {
    const ctx = await getContext();
    const goals = (ctx as unknown as { goals?: { get?: unknown } }).goals;
    expect(goals, "ctx.goals mounted").toBeDefined();

    const commands = (ctx as unknown as { commands?: { list?: () => Array<{ name: string }> } }).commands;
    expect(commands?.list?.().map((c) => c.name)).toContain("goal");

    const tools = (ctx as unknown as { tools?: { get?: (name: string) => unknown } }).tools;
    expect(tools?.get?.("get_goal"), "get_goal tool registered").toBeDefined();
    expect(tools?.get?.("create_goal"), "create_goal tool registered").toBeDefined();
    expect(tools?.get?.("update_goal"), "update_goal tool registered").toBeDefined();
  }, 90000);
});

describe("goal projection shape", () => {
  it("is null before create and carries the durable view after a create event", () => {
    const init = goalProjectionDefinition.init();
    expect(init.current).toBeNull();
    expect(goalProjectionDefinition.wire.view(init)).toBeNull();

    const next = applyGoalProjection(init, makeCreateEvent());
    expect(next.failure).toBeNull();
    const wire = toGoalWire(next.current);
    expect(wire).toMatchObject({
      id: "goal-1",
      revision: 1,
      objective: "Ship the widget",
      phase: "active",
      roundsStarted: 0,
      maxGoalRounds: 5,
      createdAt: 1000,
      updatedAt: 1000,
    });
    // The wire view is what the renderer chip consumes — same shape.
    expect(goalProjectionDefinition.wire.view(next)).toMatchObject({ goal: { id: "goal-1" } });
  });
});

describe("mountGoalBridge", () => {
  function projections() {
    return sent
      .filter((s) => s.channel === "session:projection")
      .map((s) => s.payload as { sessionId: string; kind: string; data: { goal: unknown; operation?: string } });
  }

  it("re-emits goal/changed as a goal projection with the wire shape", async () => {
    const handlers = new Map<string, (payload: unknown) => void>();
    const fakeCtx = { on: vi.fn((event: string, fn: (payload: unknown) => void) => { handlers.set(event, fn); }) };
    mountGoalBridge(fakeCtx as never);
    expect(handlers.has("goal/changed")).toBe(true);

    handlers.get("goal/changed")?.({
      agent: { session: { id: "session-g" } },
      change: {
        operation: "create",
        ref: { id: "goal-1", revision: 1 },
        goal: {
          id: "goal-1", revision: 1, objective: "Ship the widget", phase: "active",
          maxGoalRounds: 5, roundsStarted: 0, createdAt: 1000, updatedAt: 1000,
          activation: "armed",
        },
      },
    });
    await vi.waitFor(() => expect(projections()).toHaveLength(1));
    const proj = projections()[0]!;
    expect(proj.kind).toBe("goal");
    expect(proj.sessionId).toBe("session-g");
    expect(proj.data.operation).toBe("create");
    // Durable fields cross the bridge; process-local activation does not.
    expect(proj.data.goal).toMatchObject({ id: "goal-1", objective: "Ship the widget", phase: "active" });
    expect(proj.data.goal).not.toHaveProperty("activation");
  });

  it("emits a null goal on clear so the chip hides", async () => {
    const handlers = new Map<string, (payload: unknown) => void>();
    const fakeCtx = { on: vi.fn((event: string, fn: (payload: unknown) => void) => { handlers.set(event, fn); }) };
    mountGoalBridge(fakeCtx as never);

    handlers.get("goal/changed")?.({
      agent: { session: { id: "session-g" } },
      change: { operation: "clear", ref: { id: "goal-1", revision: 2 } },
    });
    await vi.waitFor(() => expect(projections()).toHaveLength(1));
    expect(projections()[0]!.data.goal).toBeNull();
  });

  it("mount is idempotent per context", () => {
    const fakeCtx = { on: vi.fn() };
    mountGoalBridge(fakeCtx as never);
    mountGoalBridge(fakeCtx as never);
    expect(fakeCtx.on).toHaveBeenCalledTimes(1);
  });
});

describe("readGoalSnapshot", () => {
  it("returns null when the session has no inspectable log", async () => {
    const fakeCtx = {
      sessions: { get: () => undefined },
      sessionPersistence: { inspect: async () => { throw new Error("no such session"); } },
    };
    await expect(readGoalSnapshot(fakeCtx as never, "missing")).resolves.toBeNull();
  });

  it("folds the live in-memory log when the session is resident", async () => {
    const fakeCtx = {
      sessions: { get: () => ({ snapshotEvents: () => [makeCreateEvent()] }) },
    };
    await expect(readGoalSnapshot(fakeCtx as never, "live-session")).resolves.toMatchObject({
      id: "goal-1",
      objective: "Ship the widget",
      phase: "active",
    });
  });
});
