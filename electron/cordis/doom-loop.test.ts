/**
 * Unit test for cairnDoomLoopPlugin's tools/pre-execute guard. Uses a fake ctx
 * that captures the registered handler, then fires synthetic pre-execute calls
 * to verify the DOOM_LOOP_THRESHOLD trigger + allow/deny handling — no live model.
 */
import { describe, it, expect } from "vitest";
import { cairnDoomLoopPlugin } from "./cairn-plugins";

type PreHandler = (...args: unknown[]) => Promise<unknown> | unknown;

function makeCtx() {
  let preHandler: PreHandler | null = null;
  const ctx = {
    on: (ev: string, fn: PreHandler) => {
      if (ev === "tools/pre-execute") preHandler = fn;
      return () => { preHandler = null; };
    },
  };
  return { ctx, invoke: (name: string, args: unknown) => (preHandler as PreHandler)({ name, arguments: args }, async () => ({ kind: "allow" })) };
}

describe("cairnDoomLoopPlugin", () => {
  it("pauses on the 3rd identical call and denies when the user rejects", async () => {
    const { ctx, invoke } = makeCtx();
    const sent: Array<{ channel: string; payload: Record<string, unknown> }> = [];
    let capturedCallId = "";
    cairnDoomLoopPlugin(ctx as never, {
      sessionId: "s1",
      send: (channel, payload) => { sent.push({ channel, payload }); },
      registerPending: (callId, resolve) => {
        capturedCallId = callId;
        // Simulate the user DENYING the doom-loop.
        setTimeout(() => resolve(false), 0);
        return () => {};
      },
    });

    const args = { path: "a.ts", content: "x" };
    const r1 = await invoke("write", args);
    const r2 = await invoke("write", args);
    expect((r1 as { kind: string }).kind).toBe("allow");
    expect((r2 as { kind: string }).kind).toBe("allow");
    // 3rd identical call trips the threshold → pause + deny.
    const r3 = await invoke("write", args);
    expect(sent.some((s) => s.channel === "pi-agent:doom-loop")).toBe(true);
    // callId is `${sessionId}:${signature}` — stable + session-scoped.
    expect(capturedCallId.startsWith("s1:write:")).toBe(true);
    expect((r3 as { kind: string }).kind).toBe("deny");
  });

  it("allows and stops re-pausing once the user approves", async () => {
    const { ctx, invoke } = makeCtx();
    const sent: Array<{ channel: string; payload: Record<string, unknown> }> = [];
    cairnDoomLoopPlugin(ctx as never, {
      sessionId: "s2",
      send: (channel, payload) => { sent.push({ channel, payload }); },
      registerPending: (_callId, resolve) => { setTimeout(() => resolve(true), 0); return () => {}; },
    });

    const args = { command: "ls" };
    await invoke("bash", args);
    await invoke("bash", args);
    const r3 = await invoke("bash", args); // trips → user allows
    expect((r3 as { kind: string }).kind).toBe("allow");
    const doomCount = sent.filter((s) => s.channel === "pi-agent:doom-loop").length;
    // 4th+ identical calls do NOT re-pause (approved sticks).
    await invoke("bash", args);
    await invoke("bash", args);
    expect(sent.filter((s) => s.channel === "pi-agent:doom-loop").length).toBe(doomCount);
  });

  it("does not trip for different tools / args", async () => {
    const { ctx, invoke } = makeCtx();
    const sent: Array<{ channel: string; payload: Record<string, unknown> }> = [];
    cairnDoomLoopPlugin(ctx as never, {
      sessionId: "s3",
      send: (channel, payload) => { sent.push({ channel, payload }); },
      registerPending: () => () => {},
    });
    await invoke("read", { path: "a.ts" });
    await invoke("read", { path: "b.ts" });
    await invoke("read", { path: "c.ts" });
    await invoke("grep", { pattern: "x" });
    expect(sent.some((s) => s.channel === "pi-agent:doom-loop")).toBe(false);
  });
});
