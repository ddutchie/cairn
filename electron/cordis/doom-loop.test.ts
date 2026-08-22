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
  const asks: Array<{ title?: string; detail?: string; toolName?: string }> = [];
  const ctx = {
    on: (ev: string, fn: PreHandler) => {
      if (ev === "tools/pre-execute") preHandler = fn;
      return () => { preHandler = null; };
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
  return { ctx, invoke, asks };
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

  it("allows and stops re-pausing once the user approves through the seam", async () => {
    const { ctx, invoke, asks } = makeCtx(["allowed-once"]);
    cairnDoomLoopPlugin(ctx as never, { sessionId: "s2" });

    const args = { command: "ls" };
    await invoke("bash", args);
    await invoke("bash", args);
    const r3 = await invoke("bash", args); // trips → user allows
    expect((r3 as { kind: string }).kind).toBe("allow");
    // 4th+ identical calls do NOT re-ask (approved sticks).
    await invoke("bash", args);
    await invoke("bash", args);
    expect(asks).toHaveLength(1);
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
});
