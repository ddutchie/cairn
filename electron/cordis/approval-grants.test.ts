/**
 * Unit tests for the approval-gating fixes (docs/approval-gating-audit.md §5
 * Phase A): durable per-session grants (tool + exact bash command) that survive
 * the per-turn plugin mount, and doom-loop visibility when the approval
 * classifier claims a call. Uses a fake ctx whose listener chain mirrors dsh's
 * waterfall semantics (registration order; next() chains to the following
 * listener). No live model.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { cairnApprovalPlugin } from "./cairn-plugins";
import { cairnDoomLoopPlugin } from "./plugins/doom-loop";
import {
  getSessionGrants, clearSessionGrants, canonicalBashCommand,
  createPendingAskRegistry,
  recordPendingApprovalArgs, readPendingApprovalArgs, forgetPendingApprovalArgs, forgetSessionApprovalArgs,
} from "./approval-grants";

type Handler = (a: unknown, b: unknown) => Promise<unknown> | unknown;

/** Fake ctx: captures listeners per event and chains them like ctx.waterfall. */
function makeCtx() {
  const pre: Handler[] = [];
  const answerers: Handler[] = [];
  const ctx = {
    on: (ev: string, fn: Handler) => {
      if (ev === "tools/pre-execute") pre.push(fn);
      if (ev === "approval/request") answerers.push(fn);
      return () => {
        let i = pre.indexOf(fn); if (i >= 0) pre.splice(i, 1);
        i = answerers.indexOf(fn); if (i >= 0) answerers.splice(i, 1);
      };
    },
  };
  const chain = (handlers: Handler[], exec: unknown, fallback: unknown): (() => Promise<unknown>) => {
    const build = (i: number): (() => Promise<unknown>) =>
      i < handlers.length
        ? async () => handlers[i](exec, build(i + 1))
        : async () => fallback;
    return build(0);
  };
  return {
    ctx,
    /** Fire tools/pre-execute through every registered listener in order. */
    invokePre: (name: string, args: unknown, fallback = { kind: "allow" }) =>
      chain(pre, { name, arguments: args, callId: `call-${name}` }, fallback)(),
    /** Fire the approval/request waterfall (answerer gets a next() too). */
    invokeAnswerer: (req: Record<string, unknown>, fallback = "unavailable") =>
      chain(answerers, req, fallback)(),
    /**
     * Full scheduler step: pre-execute, then — like dsh-tools' serviceAsk —
     * dispatch approval/request when a listener claims the call with ask.
     */
    invokeTool: async (name: string, args: unknown) => {
      const res = (await chain(pre, { name, arguments: args, callId: `call-${name}` }, { kind: "allow" })()) as { kind?: string };
      if (res?.kind === "ask") {
        await chain(answerers, { toolName: name, callId: `call-${name}` }, "unavailable")();
        return { kind: "ask" };
      }
      return res;
    },
    counts: () => ({ pre: pre.length, answerers: answerers.length }),
  };
}

function makeHarness(
  sessionId: string,
  opts: {
    decide?: (callId: string) => { approved: boolean; grant?: "session" | "command" };
    /** Never answer the ask — lets the fail-closed timeout win. */
    neverRespond?: boolean;
    timeoutMs?: number;
  } = {},
) {
  const h = makeCtx();
  const sent: Array<{ channel: string; payload: Record<string, unknown> }> = [];
  const dispose = cairnApprovalPlugin(h.ctx as never, {
    autoApprove: false,
    sessionId,
    send: (channel, payload) => { sent.push({ channel, payload }); },
    registerPending: (callId, resolve) => {
      if (!opts.neverRespond) {
        setTimeout(() => resolve(opts.decide?.(callId) ?? { approved: true }), 0);
      }
      return () => {};
    },
    timeoutMs: opts.timeoutMs,
  });
  return { ...h, sent, dispose: () => dispose?.() };
}

function hasProjection(sent: Array<{ channel: string; payload: Record<string, unknown> }>, kind: string, status?: string): boolean {
  return sent.some((event) => event.channel === "session:projection"
    && event.payload.kind === kind
    && (status === undefined || (event.payload.data as { status?: string } | undefined)?.status === status));
}

beforeEach(() => {
  for (const sid of ["s1", "s2", "s3", "s4"]) clearSessionGrants(sid);
});

describe("canonicalBashCommand", () => {
  it("trims and collapses whitespace so cosmetic reformatting still matches", () => {
    expect(canonicalBashCommand("  rm -rf   build/ dist/ \n")).toBe("rm -rf build/ dist/");
    expect(canonicalBashCommand("\tnpm   test")).toBe("npm test");
  });
  it("returns null for empty or non-string input", () => {
    expect(canonicalBashCommand(undefined)).toBeNull();
    expect(canonicalBashCommand(42)).toBeNull();
    expect(canonicalBashCommand("   ")).toBeNull();
  });
});

describe("approval grant store", () => {
  it("returns a stable store per session and isolates sessions", () => {
    const a1 = getSessionGrants("s1");
    const a2 = getSessionGrants("s1");
    expect(a1).toBe(a2);
    a1.tools.add("write");
    expect(getSessionGrants("s2").tools.has("write")).toBe(false);
    clearSessionGrants("s1");
    expect(getSessionGrants("s1").tools.has("write")).toBe(false);
  });
});

describe("cairnApprovalPlugin ask-classification", () => {
  it("passes safe tools through and asks for mutating tools", async () => {
    const { invokeTool, sent } = makeHarness("s1");
    const read = await invokeTool("read", { path: "a.ts" });
    expect((read as { kind: string }).kind).toBe("allow");
    const write = await invokeTool("write", { path: "a.ts", content: "x" });
    expect((write as { kind: string }).kind).toBe("ask");
    expect(hasProjection(sent, "approval", "required")).toBe(true);
  });

  it("keeps a grant:'session' alive across plugin re-mounts (turn boundary)", async () => {
    // Turn 1: user approves with "Always allow this tool".
    const turn1 = makeHarness("s2", { decide: () => ({ approved: true, grant: "session" }) });
    const asked = await turn1.invokeTool("bash", { command: "ls" });
    expect((asked as { kind: string }).kind).toBe("ask");
    expect(hasProjection(turn1.sent, "approval", "required")).toBe(true);
    turn1.dispose(); // simulate end of turn — the mount is disposed

    // Turn 2: fresh mount on a fresh ctx — the grant must still hold.
    const turn2 = makeHarness("s2");
    const result = await turn2.invokeTool("bash", { command: "ls -la /other" });
    expect((result as { kind: string }).kind).toBe("allow");
    expect(hasProjection(turn2.sent, "approval", "required")).toBe(false);
  });

  it("grant:'command' allows exactly the granted bash command, nothing broader", async () => {
    // Seed via the same path the respond-tool handler uses.
    const cmd = canonicalBashCommand("rm -rf   build/")!;
    getSessionGrants("s3").bashCommands.add(cmd);

    const { invokeTool, sent } = makeHarness("s3");
    const sameCmd = await invokeTool("bash", { command: "rm -rf build/" }); // whitespace differs only cosmetically
    expect((sameCmd as { kind: string }).kind).toBe("allow");
    expect(hasProjection(sent, "approval", "required")).toBe(false);

    const otherCmd = await invokeTool("bash", { command: "rm -rf dist/" });
    expect((otherCmd as { kind: string }).kind).toBe("ask");
    expect(hasProjection(sent, "approval", "required")).toBe(true);
  });
});

describe("doom-loop sees calls claimed by the approval classifier", () => {
  it("doom-loop pauses via ctx.cairn.confirm on the 3rd identical mutating call even with approvals denying", async () => {
    const h = makeCtx();
    const sent: Array<{ channel: string; payload: Record<string, unknown> }> = [];
    const doomAsks: Array<{ toolName?: string }> = [];
    // Mount order mirrors the fixed run-cordis-coding.ts: doom FIRST. The
    // plugin consumes ctx.cairn.confirm; script it to REJECT (user halt).
    (h.ctx as unknown as { cairn?: unknown }).cairn = {
      confirm: async (_sid: string, req: { toolName?: string }) => {
        doomAsks.push(req);
        return "rejected" as const;
      },
    };
    cairnDoomLoopPlugin(h.ctx as never, { sessionId: "s4" });
    cairnApprovalPlugin(h.ctx as never, {
      autoApprove: false,
      sessionId: "s4",
      send: (channel, payload) => { sent.push({ channel, payload }); },
      registerPending: (_c, resolve) => { setTimeout(() => resolve({ approved: false }), 0); return () => {}; },
    });

    const args = { command: "cargo build" };
    const r1 = await h.invokePre("bash", args);
    const r2 = await h.invokePre("bash", args);
    expect((r1 as { kind: string }).kind).toBe("ask"); // approval asks each time…
    expect((r2 as { kind: string }).kind).toBe("ask");
    const r3 = await h.invokePre("bash", args);
    // …but the doom guard still counted every identical call and trips 3rd,
    // asking through the host seam before the approval classifier sees it.
    expect(doomAsks).toHaveLength(1);
    expect(doomAsks[0].toolName).toBe("bash");
    expect((r3 as { kind: string }).kind).toBe("deny");
  });
});

describe("pending-ask registry", () => {
  it("records, lists per session, resolves, and clears sessions", () => {
    const reg = createPendingAskRegistry();
    reg.record({ sessionId: "a", name: "write", label: "Write", callId: "c1" });
    reg.record({ sessionId: "b", name: "bash", label: "Bash", callId: "c2" });
    expect(reg.listForSession("a")).toHaveLength(1);
    expect(reg.listForSession("b")[0].callId).toBe("c2");
    reg.resolve("a", "c1");
    expect(reg.listForSession("a")).toHaveLength(0);
    reg.record({ sessionId: "b", name: "edit", label: "Edit", callId: "c3" });
    reg.clearSession("b");
    expect(reg.listForSession("b")).toHaveLength(0);
  });
});

describe("fail-closed timeouts (audit G6)", () => {
  it("approval ask expires: settles cancelled, emits expiry, records NO grant", async () => {
    const { invokeTool, sent } = makeHarness("s1", {
      neverRespond: true,
      decide: () => ({ approved: true, grant: "session" }), // would grant if answered
      timeoutMs: 5,
    });
    const result = await invokeTool("bash", { command: "cargo build" });
    await new Promise((r) => setTimeout(r, 15));
    expect(hasProjection(sent, "approval", "expired")).toBe(true);
    // The timeout won the race — no standing grant may be recorded.
    expect(getSessionGrants("s1").tools.size).toBe(0);
    expect((result as { kind: string }).kind).toBe("ask");
  });

  it("doom-loop pause fails closed into a precautionary deny when the seam answers 'cancelled'", async () => {
    const h = makeCtx();
    (h.ctx as unknown as { cairn?: unknown }).cairn = {
      confirm: async () => "cancelled" as const,
    };
    cairnDoomLoopPlugin(h.ctx as never, { sessionId: "s4" });
    const args = { command: "make all" };
    await h.invokePre("bash", args);
    await h.invokePre("bash", args);
    const r3 = await h.invokePre("bash", args);
    const denied = r3 as { kind: string; reason?: string };
    expect(denied.kind).toBe("deny");
    expect(denied.reason).toContain("time limit");
  });

  it("an answered approval still wins when it arrives before the timeout", async () => {
    const { invokeTool, sent } = makeHarness("s3", {
      timeoutMs: 10_000,
      decide: () => ({ approved: true, grant: "session" }),
    });
    const result = await invokeTool("bash", { command: "ls" });
    expect((result as { kind: string }).kind).toBe("ask"); // asked…
    expect(hasProjection(sent, "approval", "expired")).toBe(false); // …answered, not expired
    expect(getSessionGrants("s3").tools.has("bash")).toBe(true);
  });

  it("SYNCHRONOUS registerPending resolve does not TDZ-throw (heartbeat auto-allow path)", async () => {
    // Regression for the pre-fix bug: settle() → dispose() would read `const
    // dispose` before its initializer ran when registerPending resolved on
    // the same tick (heartbeat-runner.ts:605-611 does exactly this). dsh's
    // ApprovalService.decide caught the ReferenceError and returned
    // 'unavailable' → deny — silently breaking standing rules. Verify the
    // ref indirection lets a sync-resolve settle cleanly and record grants.
    const h = makeCtx();
    let disposedCleanly = false;
    const dispose = cairnApprovalPlugin(h.ctx as never, {
      autoApprove: false,
      sessionId: "sync-s",
      send: () => {},
      // Resolve synchronously (no setTimeout) — this is the exact shape of
      // heartbeat's auto-allow branch which returns resolve({approved:true})
      // immediately without a microtask.
      registerPending: (_callId, resolve) => {
        resolve({ approved: true, grant: "session" });
        return () => { disposedCleanly = true; };
      },
      timeoutMs: 10_000,
    });
    const res = (await h.invokeTool("bash", { command: "ls" })) as { kind: string };
    expect(res.kind).toBe("ask"); // classifier claimed the call
    // No TDZ throw → the standing grant was recorded and dispose ran.
    expect(getSessionGrants("sync-s").tools.has("bash")).toBe(true);
    expect(disposedCleanly).toBe(true);
    dispose?.();
  });
});

describe("pendingApprovalArgs (main-side trusted arg stash — confused-deputy fix)", () => {
  beforeEach(() => {
    forgetSessionApprovalArgs("s-args");
  });

  it("returns undefined for a callId that was never recorded", () => {
    expect(readPendingApprovalArgs("s-args", "unknown-call")).toBeUndefined();
  });

  it("records + reads back the exact arg object stashed at pre-execute time", () => {
    const args = { command: "npm test", cwd: "/proj" };
    recordPendingApprovalArgs("s-args", "call-1", args);
    expect(readPendingApprovalArgs("s-args", "call-1")).toEqual(args);
  });

  it("scopes reads to (sessionId, callId) — a different session can't observe args", () => {
    recordPendingApprovalArgs("s-args", "call-1", { command: "rm -rf /" });
    expect(readPendingApprovalArgs("other-session", "call-1")).toBeUndefined();
  });

  it("forgetPendingApprovalArgs drops one entry; forgetSessionApprovalArgs drops all", () => {
    recordPendingApprovalArgs("s-args", "call-1", { command: "a" });
    recordPendingApprovalArgs("s-args", "call-2", { command: "b" });
    recordPendingApprovalArgs("s-args", "call-3", { command: "c" });
    forgetPendingApprovalArgs("s-args", "call-2");
    expect(readPendingApprovalArgs("s-args", "call-1")).toBeDefined();
    expect(readPendingApprovalArgs("s-args", "call-2")).toBeUndefined();
    expect(readPendingApprovalArgs("s-args", "call-3")).toBeDefined();
    forgetSessionApprovalArgs("s-args");
    expect(readPendingApprovalArgs("s-args", "call-1")).toBeUndefined();
    expect(readPendingApprovalArgs("s-args", "call-3")).toBeUndefined();
  });

  it("cairnApprovalPlugin stashes the trusted args at pre-execute for a gated bash call", async () => {
    forgetSessionApprovalArgs("s-stash");
    const h = makeCtx();
    const dispose = cairnApprovalPlugin(h.ctx as never, {
      autoApprove: false,
      sessionId: "s-stash",
      send: () => {},
      registerPending: () => () => {},
      timeoutMs: 100,
    });
    // Fire ONLY the pre-execute half (invokePre — not invokeTool) so the
    // ask doesn't settle and clear the stash before we can read it. In
    // production, main-side observes the args in the pi-agent:respond-tool
    // handler which runs while the ask is still pending.
    const res = (await h.invokePre("bash", { command: "true # trusted" })) as { kind: string };
    expect(res.kind).toBe("ask");
    const stashed = readPendingApprovalArgs("s-stash", "call-bash");
    expect(stashed).toBeDefined();
    expect(stashed?.command).toBe("true # trusted");
    dispose?.();
    forgetSessionApprovalArgs("s-stash");
  });
});
