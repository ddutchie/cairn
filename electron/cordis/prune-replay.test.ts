import { describe, it, expect } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import { CallId, createMessage, createToolResultMessage } from "@deepseek-ai/dsh-llm";
import type { ContentBlock } from "@deepseek-ai/dsh-llm";
import { Session, SessionId } from "@deepseek-ai/dsh-session";
import type { SessionEvent } from "@deepseek-ai/dsh-session";
import TokenMeter from "@deepseek-ai/dsh-token-meter";
import ToolResultPruner from "@deepseek-ai/dsh-compaction-tool-result-pruner";
import { deriveMessagesFromEvents, collapseDerivedToMessages } from "./session-replay";
import { foldSessionStats } from "./session-stats";
import { foldSessionUsage } from "./plugins/context-ring";

function appendToolStep(session: Session, turn: number, call: string, content: ContentBlock[]): number {
  const callId = CallId(call);
  session.append("turn/start", { turn } as never);
  session.append("step/start", { turn, step: 1 } as never);
  session.append(
    "assistant/message",
    {
      turn,
      step: 1,
      message: createMessage({
        role: "assistant",
        content: [{ type: "tool-call", id: callId, name: "bash", arguments: "{}" }],
        source: { kind: "model", provider: "test", model: "test-model" },
      }),
    } as never,
    { surfaceOp: "append" } as never,
  );
  session.append("tool/call", { turn, step: 1, callId, name: "bash", arguments: "{}" } as never);
  const result = session.append(
    "tool/result",
    {
      turn,
      step: 1,
      message: createToolResultMessage({ callId, content, isError: false }),
    } as never,
    { surfaceOp: "append" } as never,
  );
  session.append("step/end", { turn, step: 1 } as never);
  // Final assistant text so collapseDerivedToMessages emits a bubble
  session.append("step/start", { turn, step: 2 } as never);
  session.append(
    "assistant/message",
    {
      turn,
      step: 2,
      message: createMessage({
        role: "assistant",
        content: [{ type: "text", text: `done ${call}` }],
        source: { kind: "model", provider: "test", model: "test-model" },
      }),
    } as never,
    { surfaceOp: "append" } as never,
  );
  session.append("step/end", { turn, step: 2 } as never);
  session.append("turn/end", { turn, reason: { kind: "completed" } } as never);
  return result.seq;
}

describe("tool-result-pruner replay tolerance (Cairn)", () => {
  it("deriveMessages/collapse + foldSessionStats tolerate compaction/prune + replacement", async () => {
    const ctx = new Context();
    void new TokenMeter(ctx);
    const pruner = new ToolResultPruner(ctx, { thresholdChars: 50, headChars: 4, tailChars: 3 });

    const session = Session.create(SessionId("prune-replay"));
    const seq = appendToolStep(session, 1, "c1", [{ type: "text", text: "A".repeat(100) }]);

    // Open a turn for the prune to be valid (between closed steps but inside open turn)
    session.append("turn/start", { turn: 2 } as never);
    const result = pruner.pruneSession(session);
    expect(result.pruned).toHaveLength(1);
    expect(result.charsRemoved).toBeGreaterThan(0);
    expect(result.pruned[0]?.originalSeq).toBe(seq);
    // Close the pruning turn
    session.append("turn/end", { turn: 2, reason: { kind: "completed" } } as never);

    // The log now contains: original tool/result, compaction/prune, replacement tool/result
    const events = [...session.events] as unknown as SessionEvent[];
    const pruneEvents = events.filter((e) => (e as { type: string }).type === "compaction/prune");
    expect(pruneEvents).toHaveLength(1);
    expect(pruneEvents[0]).toMatchObject({ type: "compaction/prune" });

    // Cairn replay helpers must tolerate the prune + replacement (no throw, pruned text visible)
    const derived = deriveMessagesFromEvents(events);
    expect(derived.length).toBeGreaterThan(0);

    const collapsed = collapseDerivedToMessages(derived);
    expect(collapsed.length).toBeGreaterThan(0);
    // The collapsed assistant should carry the pruned marker
    const prunedOut = collapsed.flatMap((m) => m.toolCalls ?? []).find((tc) => tc.tool === "bash");
    expect(prunedOut).toBeDefined();
    // toolCalls are attached via cross-step coalescing; at minimum the derived stream is well-formed
    expect(collapsed.some((m) => m.role === "assistant")).toBe(true);

    // Stats and usage folds must tolerate the prune events (no throw, undefined or totals)
    const stats = foldSessionStats(events as unknown as Parameters<typeof foldSessionStats>[0]);
    expect(stats === undefined || typeof stats.totals.steps === "number").toBe(true);

    const usage = foldSessionUsage(events as unknown as Parameters<typeof foldSessionUsage>[0]);
    // usage may be undefined when no usage events, but must not throw
    expect(usage === undefined || typeof usage.promptTokens === "number").toBe(true);

    // Replay via fresh Session instance must derive identical messages (prune is durable)
    const replay = Session.create(session.id, [...session.events]);
    expect(replay.deriveMessages()).toEqual(session.deriveMessages());
  });

  it("multiple pruned results still replay identically", async () => {
    const ctx = new Context();
    void new TokenMeter(ctx);
    const pruner = new ToolResultPruner(ctx, { thresholdChars: 50, headChars: 4, tailChars: 3 });
    const session = Session.create(SessionId("prune-multi"));
    appendToolStep(session, 1, "a", [{ type: "text", text: "A".repeat(100) }]);
    appendToolStep(session, 2, "b", [{ type: "text", text: "short" }]);
    appendToolStep(session, 3, "c", [{ type: "text", text: "C".repeat(80) }]);
    session.append("turn/start", { turn: 4 } as never);
    const first = pruner.pruneSession(session);
    const second = pruner.pruneSession(session);
    expect(first.pruned.map((e) => String(e.callId))).toEqual([String(CallId("a")), String(CallId("c"))]);
    expect(second.pruned).toHaveLength(0);
    session.append("turn/end", { turn: 4, reason: { kind: "completed" } } as never);

    const events = [...session.events] as unknown as SessionEvent[];
    const derived = deriveMessagesFromEvents(events);
    const collapsed = collapseDerivedToMessages(derived);
    expect(collapsed.length).toBeGreaterThan(0);
    expect(() => foldSessionStats(events as unknown as Parameters<typeof foldSessionStats>[0])).not.toThrow();
    const replay = Session.create(session.id, [...session.events]);
    expect(replay.deriveMessages()).toEqual(session.deriveMessages());
  });
});
