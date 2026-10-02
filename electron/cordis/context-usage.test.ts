/**
 * Context Ring usage built from dsh-token-meter's projections
 * (electron/cordis/context-usage.ts): node classification, scaling the
 * heuristic slices onto the provider's real prompt size, and the offline fold
 * through the token meter's real registered definitions.
 */
import { describe, it, expect } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import { ToolCallId, createMessage, createToolResultMessage } from "@deepseek-ai/dsh-llm";
import { Session, SessionId, type SessionEvent } from "@deepseek-ai/dsh-session";
import TokenMeter from "@deepseek-ai/dsh-token-meter";
import { buildSessionUsage, classifyNode, foldSessionUsageOffline, readLiveSessionUsage, usageChunkEvent } from "./context-usage";

async function meterCtx(): Promise<Context> {
  const ctx = new Context();
  const { default: ProjectionRegistry } = await import("@deepseek-ai/dsh-session-projection");
  await ctx.plugin(ProjectionRegistry as never, {} as never);
  void new TokenMeter(ctx);
  return ctx;
}

/** One turn: system prompt, skill catalog, user prompt, a tool round, and a reply with cached usage. */
function buildSession(): Session {
  const session = Session.create(SessionId("ring-usage"));
  const callId = ToolCallId("c1");
  session.append("turn/start", { turn: 1 } as never);
  session.append("step/start", { turn: 1, step: 1 } as never);
  session.append("system/message", { turn: 1, step: 1, message: { ...createMessage({ role: "system", content: [{ type: "text", text: "S".repeat(4000) }], source: { kind: "system-prompt" } }) } } as never, { surfaceOp: "append" } as never);
  session.append("user/message", createMessage({ role: "user", content: [{ type: "text", text: "K".repeat(800) }], source: { kind: "skill-catalog", form: "catalog" } as never }) as never, { surfaceOp: "append" } as never);
  session.append("user/message", createMessage({ role: "user", content: [{ type: "text", text: "U".repeat(2000) }], source: { kind: "user" } }) as never, { surfaceOp: "append" } as never);
  session.append("assistant/message", {
    turn: 1, step: 1, stream: [],
    message: createMessage({ role: "assistant", content: [{ type: "tool-call", id: callId, name: "bash", arguments: "{}" }], source: { kind: "model", provider: "test", model: "test-model" } }),
    usage: { inputTokens: 9000, outputTokens: 20 },
  } as never, { surfaceOp: "append" } as never);
  session.append("tool/call", { turn: 1, step: 1, callId, name: "bash", arguments: "{}" } as never);
  session.append("tool/result", { turn: 1, step: 1, message: createToolResultMessage({ callId, content: [{ type: "text", text: "T".repeat(8000) }], isError: false }) } as never, { surfaceOp: "append" } as never);
  session.append("step/end", { turn: 1, step: 1 } as never);
  session.append("step/start", { turn: 1, step: 2 } as never);
  session.append("assistant/message", {
    turn: 1, step: 2, stream: [],
    message: createMessage({ role: "assistant", content: [{ type: "text", text: "done" }], source: { kind: "model", provider: "test", model: "test-model" } }),
    // Disjoint usage: tiny uncached input, the rest served from cache.
    usage: { inputTokens: 60, outputTokens: 80, cacheReadTokens: 11000, cacheWriteTokens: 40, reasoningTokens: 5 },
  } as never, { surfaceOp: "append" } as never);
  session.append("step/end", { turn: 1, step: 2 } as never);
  session.append("turn/end", { turn: 1, reason: { kind: "completed" } } as never);
  return session;
}

describe("classifyNode", () => {
  it("buckets surface nodes by the event they came from", () => {
    expect(classifyNode({ type: "system/message" }, false)).toBe("systemPrompt");
    expect(classifyNode(undefined, true)).toBe("systemPrompt");
    expect(classifyNode({ type: "tool/result" }, false)).toBe("toolOutputs");
    expect(classifyNode({ type: "user/message", data: { source: { kind: "skill-catalog" } } }, false)).toBe("skills");
    expect(classifyNode({ type: "user/message", data: { source: { kind: "agent-instructions" } } }, false)).toBe("systemPrompt");
    expect(classifyNode({ type: "user/message", data: { source: { kind: "user" } } }, false)).toBe("conversation");
    expect(classifyNode({ type: "assistant/message" }, false)).toBe("conversation");
  });
});

describe("buildSessionUsage", () => {
  it("scales heuristic slices onto the provider's real prompt size", () => {
    const events: Record<number, { type: string; data?: unknown }> = {
      0: { type: "system/message" },
      1: { type: "user/message", data: { source: { kind: "user" } } },
      2: { type: "tool/result" },
      3: { type: "assistant/message", data: { usage: { inputTokens: 100, outputTokens: 7, cacheReadTokens: 1900 } } },
    };
    const usage = buildSessionUsage({
      pressure: { pressureTokens: 2000, surfaceTokens: 1000, sampledSurfaceTokens: 1000, contextWindow: 64000 },
      breakdown: { nodes: [{ seq: 0, heuristicTokens: 100, system: true }, { seq: 1, heuristicTokens: 300, system: false }, { seq: 2, heuristicTokens: 400, system: false }], breakdown: { toolsTokens: 200 } },
      eventAt: (seq) => events[seq],
      lastSeq: 3,
    })!;
    expect(usage.promptTokens).toBe(2000);
    expect(usage.breakdown).toEqual({ systemPrompt: 200, tools: 400, skills: 0, toolOutputs: 800, conversation: 600 });
    expect(usage.completionTokens).toBe(7);
    expect(usage.cacheReadTokens).toBe(1900);
    expect(usage.contextWindow).toBe(64000);
  });

  it("adds surface priced since the last sample (pending tool results)", () => {
    const usage = buildSessionUsage({
      pressure: { pressureTokens: 2000, surfaceTokens: 1500, sampledSurfaceTokens: 1000 },
      breakdown: { nodes: [{ seq: 0, heuristicTokens: 1500, system: false }] },
      eventAt: () => ({ type: "tool/result" }),
      lastSeq: 0,
    })!;
    expect(usage.promptTokens).toBe(2500);
  });
});

describe("foldSessionUsageOffline (real token-meter definitions)", () => {
  it("measures the latest request's full prompt and splits every slice", async () => {
    const ctx = await meterCtx();
    const events = [...buildSession().snapshotEvents()] as unknown as SessionEvent[];
    const usage = foldSessionUsageOffline(ctx, events as never)!;
    // Provider count for the latest request (60 + 11000 + 40), plus the reply it
    // produced — the meter projects what the NEXT request will carry.
    expect(usage.promptTokens).toBeGreaterThanOrEqual(60 + 11000 + 40);
    expect(usage.promptTokens).toBeLessThan(60 + 11000 + 40 + 50);
    expect(usage.completionTokens).toBe(80);
    expect(usage.reasoningTokens).toBe(5);
    expect(usage.cacheReadTokens).toBe(11000);
    expect(usage.cacheCreationTokens).toBe(40);
    const b = usage.breakdown!;
    for (const key of ["systemPrompt", "skills", "toolOutputs", "conversation"] as const) expect(b[key]).toBeGreaterThan(0);
    // The 8000-char tool output dominates the 2000-char prompt; the skill catalog
    // is counted as skills, not conversation.
    expect(b.toolOutputs).toBeGreaterThan(b.conversation);
    expect(b.skills).toBeLessThan(b.conversation);
    // Slices sum to the real total (rounding aside).
    const sum = b.systemPrompt + b.tools + b.skills + b.toolOutputs + b.conversation;
    expect(Math.abs(sum - usage.promptTokens)).toBeLessThanOrEqual(5);
  });

  it("returns undefined without the token meter's units", () => {
    expect(foldSessionUsageOffline(new Context(), [{ type: "user/message", seq: 0 }])).toBeUndefined();
  });
});

describe("readLiveSessionUsage", () => {
  it("reads the registry state for a resident session", () => {
    const states: Record<string, unknown> = {
      contextPressure: { pressureTokens: 500, surfaceTokens: 0, sampledSurfaceTokens: 0 },
      contextBreakdown: { nodes: [{ seq: 0, heuristicTokens: 50, system: false }], breakdown: { toolsTokens: 0 } },
    };
    const ctx = { sessionProjections: { stateOf: (_s: unknown, key: string) => states[key] } };
    const session = { seq: 1, eventAt: (seq: number) => (seq === 0 ? { type: "tool/result" } : undefined) };
    const usage = readLiveSessionUsage(ctx as never, session)!;
    expect(usage.promptTokens).toBe(500);
    expect(usage.breakdown?.toolOutputs).toBe(500);
  });
});

describe("usageChunkEvent", () => {
  it("marks the count as already-total (promptTokens, no inputTokens)", () => {
    const ev = usageChunkEvent({ promptTokens: 11100, completionTokens: 80, breakdown: { systemPrompt: 1, tools: 1, skills: 1, toolOutputs: 1, conversation: 1 } }) as { data: { chunk: { usage: Record<string, unknown> } } };
    expect(ev.data.chunk.usage.promptTokens).toBe(11100);
    expect(ev.data.chunk.usage.inputTokens).toBeUndefined();
    expect(usageChunkEvent(undefined)).toBeNull();
  });
});
