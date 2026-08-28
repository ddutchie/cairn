/**
 * Unit tests for the bundled doom-loop pilot plugin
 * (`electron/cordis/plugins/doom-loop.ts`). The plugin consumes ONLY public
 * seams: its own tools/pre-execute guard + `ctx.cairn.confirm()`. The fake ctx
 * captures the pre-execute handler and scripts confirm outcomes. No live model.
 */
import { describe, it, expect } from "vitest";
import { cairnDoomLoopPlugin, DOOM_LOOP_THRESHOLD } from "./plugins/doom-loop";

type PreHandler = (...args: unknown[]) => Promise<unknown> | unknown;
type ConfirmOutcome = "allowed-once" | "rejected" | "cancelled";

function makeCtx(scriptedOutcomes: ConfirmOutcome[]) {
  let preHandler: PreHandler | null = null;
  let preStepHandler: PreHandler | null = null;
  const asks: Array<{ title?: string; detail?: string; toolName?: string }> = [];
  const ctx = {
    on: (ev: string, fn: PreHandler) => {
      if (ev === "tools/pre-execute") preHandler = fn;
      if (ev === "agent/pre-step") preStepHandler = fn;
      return () => { preHandler = null; preStepHandler = null; };
    },
    cairn: {
      confirm: async (_sessionId: string, req: { title?: string; detail?: string; toolName?: string }) => {
        asks.push(req);
        return scriptedOutcomes.shift() ?? "cancelled";
      },
    },
  };
  const invoke = (name: string, args: unknown) =>
    (preHandler as PreHandler)({ name, arguments: args }, async () => ({ kind: "allow" }));
  /**
   * Drive the `agent/pre-step` waterfall exactly as dsh's agent loop does:
   * pass the real payload shape and a `next` that yields the default decision.
   */
  const preStep = (messages: Array<{ source?: { kind?: string } }>) =>
    (preStepHandler as PreHandler)(
      { messages, turn: 1, step: 1, signal: new AbortController().signal },
      async () => ({ kind: "enter", messages }),
    );
  return { ctx, invoke, asks, preStep, hasPreStep: () => preStepHandler !== null };
}

describe("cairnDoomLoopPlugin (ctx.cairn.confirm pilot)", () => {
  it("pauses via the host seam on the 3rd identical call and denies when the user rejects", async () => {
    const { ctx, invoke, asks } = makeCtx(["rejected"]);
    cairnDoomLoopPlugin(ctx as never, { sessionId: "s1" });

    const args = { path: "a.ts", content: "x" };
    expect(((await invoke("write", args)) as { kind: string }).kind).toBe("allow");
    expect(((await invoke("write", args)) as { kind: string }).kind).toBe("allow");
    // 3rd identical call trips the threshold → host confirm → user rejects.
    const r3 = await invoke("write", args);
    expect(asks).toHaveLength(1);
    expect(asks[0]).toMatchObject({ toolName: "write" });
    expect(asks[0].detail).toContain(`${DOOM_LOOP_THRESHOLD}×`);
    expect((r3 as { kind: string }).kind).toBe("deny");
    expect((r3 as { reason?: string }).reason).toContain("Halted by the user");
  });

  it("allows and re-prompts at the next threshold (3→5) when the user approves through the seam", async () => {
    const { ctx, invoke, asks } = makeCtx(["allowed-once", "allowed-once"]);
    cairnDoomLoopPlugin(ctx as never, { sessionId: "s2" });

    const args = { command: "ls" };
    await invoke("bash", args);
    await invoke("bash", args);
    const r3 = await invoke("bash", args); // trips at 3 → user allows
    expect((r3 as { kind: string }).kind).toBe("allow");
    expect(asks).toHaveLength(1);
    // 4th identical does NOT re-ask (only thresholds 3,5,8).
    await invoke("bash", args);
    expect(asks).toHaveLength(1);
    // 5th identical hits next threshold → re-prompts.
    const r5 = await invoke("bash", args);
    expect((r5 as { kind: string }).kind).toBe("allow");
    expect(asks).toHaveLength(2);
  });

  it("does not trip for different tools / args", async () => {
    const { ctx, invoke, asks } = makeCtx([]);
    cairnDoomLoopPlugin(ctx as never, { sessionId: "s3" });
    await invoke("read", { path: "a.ts" });
    await invoke("read", { path: "b.ts" });
    await invoke("read", { path: "c.ts" });
    await invoke("grep", { pattern: "x" });
    expect(asks).toHaveLength(0);
  });

  it("fails closed when the host seam answers 'cancelled' (headless / timeout)", async () => {
    const { ctx, invoke } = makeCtx([]); // default outcome: cancelled
    cairnDoomLoopPlugin(ctx as never, { sessionId: "s4" });
    const args = { command: "make all" };
    await invoke("bash", args);
    await invoke("bash", args);
    const r3 = await invoke("bash", args);
    expect((r3 as { kind: string }).kind).toBe("deny");
    expect((r3 as { reason?: string }).reason).toContain("time limit");
  });

  it("stays inert when no ctx.cairn.confirm seam exists", async () => {
    const ctx: Record<string, unknown> = {
      on: (_ev: string, fn: PreHandler) => { void fn; return () => {}; },
    };
    expect(cairnDoomLoopPlugin(ctx as never, { sessionId: "s5" })).toBeUndefined();
  });

  // ── agent/pre-step waterfall contract ─────────────────────────────────────
  // Regression guard. `agent/pre-step` is a WATERFALL: dsh's agent loop uses the
  // listener's return value as the step decision and immediately reads
  // `decision.kind`. The reset listener previously returned undefined without
  // calling next(), which collapsed the waterfall and killed EVERY coding turn
  // ~2ms after turn/start with "Cannot read properties of undefined (reading
  // 'kind')" — surfaced to users only as "Agent turn ended abnormally (error)".
  describe("agent/pre-step waterfall contract", () => {
    it("always returns the downstream decision, never undefined", async () => {
      const { ctx, preStep } = makeCtx([]);
      cairnDoomLoopPlugin(ctx as never, { sessionId: "w1" });

      // A user-sourced message (the reset path) must still yield a decision.
      const userDecision = await preStep([{ source: { kind: "user" } }]);
      expect(userDecision).toBeDefined();
      expect((userDecision as { kind?: string }).kind).toBe("enter");

      // ...and so must a non-user step (the non-reset path).
      const toolDecision = await preStep([{ source: { kind: "plugin" } }]);
      expect(toolDecision).toBeDefined();
      expect((toolDecision as { kind?: string }).kind).toBe("enter");

      // An empty claim (no messages at all) must not throw or short-circuit.
      const emptyDecision = await preStep([]);
      expect((emptyDecision as { kind?: string }).kind).toBe("enter");
    });

    it("resets the repeat streak when a new user message enters the step", async () => {
      // Trip the threshold, then start a "new user turn" and confirm the streak
      // no longer counts toward it — i.e. the reset actually fires. It never did
      // before, because the handler read a non-existent `payload.source.kind`.
      const { ctx, invoke, asks, preStep } = makeCtx(["rejected", "rejected"]);
      cairnDoomLoopPlugin(ctx as never, { sessionId: "w2" });

      const args = { command: "ls" };
      await invoke("bash", args);
      await invoke("bash", args);
      await invoke("bash", args);     // trips at 3
      expect(asks).toHaveLength(1);

      await preStep([{ source: { kind: "user" } }]);   // new user turn → reset

      await invoke("bash", args);
      await invoke("bash", args);
      expect(asks).toHaveLength(1);   // streak restarted, not yet at 3
      await invoke("bash", args);
      expect(asks).toHaveLength(2);   // trips again at 3 from the reset baseline
    });
  });
});
