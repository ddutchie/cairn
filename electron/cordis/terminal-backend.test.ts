/**
 * Unit tests for the Cairn `ctx.terminals` backend (shared node-pty manager,
 * no live model, no native PTY).
 *
 * Real `TerminalSessionService` (owner-scoped ids, fencing, cleanup) +
 * `CairnTerminalBackend` over an in-memory fake `PtyAdapter`. Proves: open /
 * send / read / kill, owner fencing, cwd defaulting, kill propagation both
 * directions (model close kills the substrate; substrate exit surfaces as
 * `exited`), SIGKILL rejection, and fail-closed spawn without a db handle.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import AgentRegistry, { Inbox } from "@deepseek-ai/dsh-agent";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { Session, SessionId } from "@deepseek-ai/dsh-session";
import TerminalSessionService from "@deepseek-ai/dsh-terminal";
import {
  CAIRN_TERMINAL_BACKEND_TYPE,
  CairnTerminalBackend,
  type PtyAdapter,
} from "./terminal-backend";

interface FakePty {
  id: string;
  cwd: string;
  pid: number;
  writes: string[];
  signals: string[];
  killed: boolean;
  dataCbs: Array<(data: string) => void>;
  exitCbs: Array<(e: { exitCode: number; signal?: number }) => void>;
}

class FakeAdapter implements PtyAdapter {
  sessions = new Map<string, FakePty>();
  spawnCwds: string[] = [];
  private next = 0;

  async spawn(cwd: string): Promise<{ sessionId: string; pid?: number }> {
    const id = `fake-${++this.next}`;
    const pty: FakePty = {
      id, cwd, pid: 1000 + this.next,
      writes: [], signals: [], killed: false,
      dataCbs: [], exitCbs: [],
    };
    this.sessions.set(id, pty);
    this.spawnCwds.push(cwd);
    // A real shell prints its prompt asynchronously (libuv, well after the
    // backend subscribes) — setTimeout, not queueMicrotask, for fidelity.
    setTimeout(() => this.emit(id, "$ "), 0);
    return { sessionId: id, pid: pty.pid };
  }

  write(sessionId: string, data: string): void {
    this.sessions.get(sessionId)?.writes.push(data);
  }

  signal(sessionId: string, sig: string): void {
    const pty = this.sessions.get(sessionId);
    if (!pty || pty.killed) throw new Error(`unknown session ${sessionId}`);
    pty.signals.push(sig);
  }

  kill(sessionId: string): void {
    const pty = this.sessions.get(sessionId);
    if (!pty) return;
    pty.killed = true;
  }

  onData(sessionId: string, cb: (data: string) => void): () => void {
    const pty = this.sessions.get(sessionId);
    if (!pty) return () => {};
    pty.dataCbs.push(cb);
    return () => {
      pty.dataCbs = pty.dataCbs.filter((c) => c !== cb);
    };
  }

  onExit(sessionId: string, cb: (e: { exitCode: number; signal?: number }) => void): () => void {
    const pty = this.sessions.get(sessionId);
    if (!pty) return () => {};
    pty.exitCbs.push(cb);
    return () => {
      pty.exitCbs = pty.exitCbs.filter((c) => c !== cb);
    };
  }

  emit(sessionId: string, data: string): void {
    for (const cb of [...(this.sessions.get(sessionId)?.dataCbs ?? [])]) cb(data);
  }

  exit(sessionId: string, exitCode = 0): void {
    for (const cb of [...(this.sessions.get(sessionId)?.exitCbs ?? [])]) cb({ exitCode });
  }

  lastSpawnedId(): string {
    return `fake-${this.next}`;
  }
}

function stubAgent(ctx: Context, rawId: string): Agent {
  const scopeFiber = ctx.plugin(() => {}) as unknown as { ctx: Context };
  const id = SessionId(rawId);
  const session = Session.create(id);
  const agent: Agent = {
    id,
    options: {},
    session,
    inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
    status: "idle",
    ctx: scopeFiber.ctx,
    send: () => {},
    followup: () => {},
    steer: () => ({ outcome: Promise.resolve({ status: "rejected" as const }) }),
    inject: () => {},
    cancel() {},
    runMaintenance: (task) => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  };
  return agent;
}

async function harness(defaultCwd = "/ws") {
  const ctx = new Context();
  await ctx.plugin(AgentRegistry);
  await ctx.plugin(TerminalSessionService);
  const adapter = new FakeAdapter();
  const backend = new CairnTerminalBackend({
    defaultCwd,
    adapter,
    idleSilenceMs: 20,
    sendTimeoutMs: 2000,
    motdTimeoutMs: 10,
    disposeGraceMs: 20,
  });
  ctx.terminals.registerBackend(backend);
  const owner = stubAgent(ctx, "owner");
  ctx.agents.register(owner);
  return { ctx, adapter, backend, owner };
}

beforeEach(() => {});

describe("CairnTerminalBackend", () => {
  it("registers under type 'shell'", async () => {
    expect(CAIRN_TERMINAL_BACKEND_TYPE).toBe("shell");
    const { ctx } = await harness();
    expect(ctx.terminals.listBackends()).toEqual(["shell"]);
  });

  it("defaults a cwd-less open to the turn workspace", async () => {
    const { ctx, adapter, owner } = await harness("/turn-cwd");
    const created = await ctx.terminals.spawn(owner, { type: "shell" });
    expect(created.sessionId).toBe("pty-1");
    expect(created.type).toBe("shell");
    expect(adapter.spawnCwds).toEqual(["/turn-cwd"]);
  });

  it("passes an explicit cwd through", async () => {
    const { ctx, adapter, owner } = await harness("/turn-cwd");
    await ctx.terminals.spawn(owner, { type: "shell", cwd: "/turn-cwd/sub" });
    expect(adapter.spawnCwds).toEqual(["/turn-cwd/sub"]);
  });

  it("sends text with Enter and settles on silence", async () => {
    const { ctx, adapter, owner } = await harness();
    const created = await ctx.terminals.spawn(owner, { type: "shell", name: "main" });
    const op = ctx.terminals.startSend(owner, created.sessionId, { text: "echo hi", submit: true });
    const pty = adapter.sessions.get(adapter.lastSpawnedId());
    expect(pty?.writes).toEqual(["echo hi\r"]);
    adapter.emit(adapter.lastSpawnedId(), "hi\n");
    const result = await op.done;
    expect(result.waitReason).toBe("inferred_idle");
    expect(result.viewport).toContain("hi");
    expect(result.sessionStatus).toEqual({ kind: "running" });
  });

  it("reads back retained scrollback", async () => {
    const { ctx, adapter, owner } = await harness();
    const created = await ctx.terminals.spawn(owner, { type: "shell" });
    const op = ctx.terminals.startSend(owner, created.sessionId, { text: "pwd", submit: true });
    adapter.emit(adapter.lastSpawnedId(), "/turn-cwd\n");
    await op.done;
    const page = ctx.terminals.read(owner, created.sessionId, {});
    expect(page.text).toContain("/turn-cwd");
    expect(page.totalLines).toBeGreaterThan(0);
    const empty = ctx.terminals.read(owner, created.sessionId, { offset: 99999 });
    expect(empty.text).toBe("");
  });

  it("rejects invalid read pagination", async () => {
    const { ctx, owner } = await harness();
    const created = await ctx.terminals.spawn(owner, { type: "shell" });
    expect(() => ctx.terminals.read(owner, created.sessionId, { offset: -1 })).toThrow("offset");
    expect(() => ctx.terminals.read(owner, created.sessionId, { count: 0 })).toThrow("count");
  });

  it("fences every operation to the exact owner", async () => {
    const { ctx, owner } = await harness();
    const foreign = stubAgent(ctx, "foreign");
    ctx.agents.register(foreign);
    const created = await ctx.terminals.spawn(owner, { type: "shell" });
    expect(ctx.terminals.list(owner)).toHaveLength(1);
    expect(ctx.terminals.list(foreign)).toEqual([]);
    expect(() => ctx.terminals.read(foreign, created.sessionId)).toThrow("another agent");
    await expect(ctx.terminals.kill(foreign, created.sessionId)).rejects.toThrow("another agent");
  });

  it("propagates model close to the substrate and drops the session", async () => {
    const { ctx, adapter, owner } = await harness();
    const created = await ctx.terminals.spawn(owner, { type: "shell" });
    const pty = adapter.sessions.get(adapter.lastSpawnedId());
    expect(await ctx.terminals.kill(owner, created.sessionId)).toBe(true);
    expect(pty?.killed).toBe(true);
    expect(ctx.terminals.list(owner)).toEqual([]);
    await expect(ctx.terminals.kill(owner, created.sessionId)).rejects.toThrow("unknown PTY");
  });

  it("surfaces substrate exit as an exited status", async () => {
    const { ctx, adapter, owner } = await harness();
    const created = await ctx.terminals.spawn(owner, { type: "shell" });
    adapter.exit(adapter.lastSpawnedId(), 1);
    await new Promise((r) => setTimeout(r, 0));
    const listed = ctx.terminals.list(owner);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.status).toMatchObject({ kind: "exited", exitCode: 1 });
    expect(() =>
      ctx.terminals.startSend(owner, created.sessionId, { text: "echo late", submit: true }),
    ).toThrow("exited");
  });

  it("settles an in-flight send when the substrate exits", async () => {
    const { ctx, adapter, owner } = await harness();
    const created = await ctx.terminals.spawn(owner, { type: "shell" });
    const op = ctx.terminals.startSend(owner, created.sessionId, { text: "sleep 30", submit: true });
    adapter.exit(adapter.lastSpawnedId(), 143);
    const result = await op.done;
    expect(result.waitReason).toBe("session_exit");
    expect(result.sessionStatus).toMatchObject({ kind: "exited", exitCode: 143 });
  });

  it("delivers signals but rejects SIGKILL", async () => {
    const { ctx, adapter, owner } = await harness();
    const created = await ctx.terminals.spawn(owner, { type: "shell" });
    const delivered = await ctx.terminals.signal(owner, created.sessionId, "SIGINT");
    expect(delivered).toMatchObject({ delivered: true });
    expect(adapter.sessions.get(adapter.lastSpawnedId())?.signals).toEqual(["SIGINT"]);
    await expect(ctx.terminals.signal(owner, created.sessionId, "SIGKILL")).rejects.toThrow(
      "terminal_close",
    );
  });

  it("fails spawn closed with neither adapter nor db", async () => {
    const ctx = new Context();
    await ctx.plugin(AgentRegistry);
    await ctx.plugin(TerminalSessionService);
    ctx.terminals.registerBackend(new CairnTerminalBackend({ defaultCwd: "/ws" }));
    const owner = stubAgent(ctx, "owner");
    ctx.agents.register(owner);
    await expect(ctx.terminals.spawn(owner, { type: "shell" })).rejects.toThrow("no database handle");
  });
});
