/**
 * Unit tests for the approval-gating fixes (docs/approval-gating-audit.md §5
 * Phase A): durable per-session grants (tool + exact bash command) that survive
 * the per-turn plugin mount, and doom-loop visibility when the approval
 * classifier claims a call. Uses a fake ctx whose listener chain mirrors dsh's
 * waterfall semantics (registration order; next() chains to the following
 * listener). No live model.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { cairnApprovalPlugin, cairnDoomLoopPlugin } from "./cairn-plugins";
import { getSessionGrants, clearSessionGrants, canonicalBashCommand } from "./approval-grants";

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
      chain(pre, { name, arguments: args }, fallback)(),
    /** Fire the approval/request waterfall (answerer gets a next() too). */
    invokeAnswerer: (req: Record<string, unknown>, fallback = "unavailable") =>
      chain(answerers, req, fallback)(),
    /**
     * Full scheduler step: pre-execute, then — like dsh-tools' serviceAsk —
     * dispatch approval/request when a listener claims the call with ask.
     */
    invokeTool: async (name: string, args: unknown) => {
      const res = (await chain(pre, { name, arguments: args }, { kind: "allow" })()) as { kind?: string };
      if (res?.kind === "ask") {
        await chain(answerers, { toolName: name, callId: `call-${name}` }, "unavailable")();
        return { kind: "ask" };
      }
      return res;
    },
    counts: () => ({ pre: pre.length, answerers: answerers.length }),
  };
}

function makeHarness(sessionId: string, decide?: (callId: string) => { approved: boolean; grant?: "session" | "command" }) {
  const h = makeCtx();
  const sent: Array<{ channel: string; payload: Record<string, unknown> }> = [];
  const dispose = cairnApprovalPlugin(h.ctx as never, {
    autoApprove: false,
    sessionId,
    send: (channel, payload) => { sent.push({ channel, payload }); },
    registerPending: (callId, resolve) => {
      setTimeout(() => resolve(decide?.(callId) ?? { approved: true }), 0);
      return () => {};
    },
  });
  return { ...h, sent, dispose: () => dispose?.() };
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
    expect(sent.some((s) => s.channel === "pi-agent:tool-confirm-required")).toBe(true);
  });

  it("keeps a grant:'session' alive across plugin re-mounts (turn boundary)", async () => {
    // Turn 1: user approves with "Always allow this tool".
    const turn1 = makeHarness("s2", () => ({ approved: true, grant: "session" }));
    const asked = await turn1.invokeTool("bash", { command: "ls" });
    expect((asked as { kind: string }).kind).toBe("ask");
    expect(turn1.sent.some((s) => s.channel === "pi-agent:tool-confirm-required")).toBe(true);
    turn1.dispose(); // simulate end of turn — the mount is disposed

    // Turn 2: fresh mount on a fresh ctx — the grant must still hold.
    const turn2 = makeHarness("s2");
    const result = await turn2.invokeTool("bash", { command: "ls -la /other" });
    expect((result as { kind: string }).kind).toBe("allow");
    expect(turn2.sent.some((s) => s.channel === "pi-agent:tool-confirm-required")).toBe(false);
  });

  it("grant:'command' allows exactly the granted bash command, nothing broader", async () => {
    // Seed via the same path the respond-tool handler uses.
    const cmd = canonicalBashCommand("rm -rf   build/")!;
    getSessionGrants("s3").bashCommands.add(cmd);

    const { invokeTool, sent } = makeHarness("s3");
    const sameCmd = await invokeTool("bash", { command: "rm -rf build/" }); // whitespace differs only cosmetically
    expect((sameCmd as { kind: string }).kind).toBe("allow");
    expect(sent.some((s) => s.channel === "pi-agent:tool-confirm-required")).toBe(false);

    const otherCmd = await invokeTool("bash", { command: "rm -rf dist/" });
    expect((otherCmd as { kind: string }).kind).toBe("ask");
    expect(sent.some((s) => s.channel === "pi-agent:tool-confirm-required")).toBe(true);
  });
});

describe("doom-loop sees calls claimed by the approval classifier", () => {
  it("emits pi-agent:doom-loop on the 3rd identical mutating call even with approvals denying", async () => {
    const h = makeCtx();
    const sent: Array<{ channel: string; payload: Record<string, unknown> }> = [];
    // Mount order mirrors the fixed run-cordis-coding.ts: doom FIRST.
    cairnDoomLoopPlugin(h.ctx as never, {
      sessionId: "s4",
      send: (channel, payload) => { sent.push({ channel, payload }); },
      registerPending: (_c, resolve) => { setTimeout(() => resolve(false), 0); return () => {}; },
    });
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
    // …but the doom guard still counted every identical call and trips 3rd.
    expect(sent.some((s) => s.channel === "pi-agent:doom-loop")).toBe(true);
    expect((r3 as { kind: string }).kind).toBe("deny");
  });
});
