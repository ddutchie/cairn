/**
 * Unit tests for the Context Ring projection fold
 * (electron/cordis/plugins/context-ring.ts) — reasoning provenance per model:
 * attribution, replay-health (replayed vs degraded), and current-model
 * tracking. Pure functions; no cordis context required.
 */
import { describe, it, expect } from "vitest";
import { applyContextRingEvent, contextRingProjectionDefinition } from "./plugins/context-ring";

const msgEvent = (provider: string, model: string, blocks: Array<{ text?: string }>, replayState?: unknown) => ({
  type: "assistant/message",
  data: {
    message: {
      content: [
        ...blocks.map((b) => ({ type: "reasoning", text: b.text })),
        { type: "text", text: "answer" },
      ],
      source: replayState === undefined ? { provider, model } : { provider, model, replayState },
    },
  },
});

describe("applyContextRingEvent", () => {
  it("attributes reasoning blocks/chars to provider::model", () => {
    let state = contextRingProjectionDefinition.init();
    state = applyContextRingEvent(state, msgEvent("cairn", "claude-sonnet-4-5", [{ text: "abcd" }, { text: "ef" }], {}));
    const bucket = state.byModel["cairn::claude-sonnet-4-5"];
    expect(bucket).toMatchObject({ turns: 1, reasoningBlocks: 2, reasoningChars: 6, replayedBlocks: 2, degradedBlocks: 0 });
    // non-reasoning content is not counted
    expect(bucket.reasoningBlocks).toBe(2);
  });

  it("counts blocks as degraded when the replay envelope is absent", () => {
    let state = contextRingProjectionDefinition.init();
    state = applyContextRingEvent(state, msgEvent("cairn", "m1", [{ text: "xyz" }]));
    const bucket = state.byModel["cairn::m1"];
    expect(bucket.replayedBlocks).toBe(0);
    expect(bucket.degradedBlocks).toBe(1);
  });

  it("splits buckets across models and accumulates turns", () => {
    let state = contextRingProjectionDefinition.init();
    state = applyContextRingEvent(state, msgEvent("cairn", "m1", [{ text: "aa" }]));
    state = applyContextRingEvent(state, msgEvent("cairn", "m2", [{ text: "bb" }]));
    state = applyContextRingEvent(state, msgEvent("cairn", "m1", [{ text: "cc" }]));
    expect(state.byModel["cairn::m1"]).toMatchObject({ turns: 2, reasoningChars: 4 });
    expect(state.byModel["cairn::m2"].turns).toBe(1);
  });

  it("tracks the next-request model from request/header", () => {
    let state = contextRingProjectionDefinition.init();
    state = applyContextRingEvent(state, { type: "request/header", data: { config: { provider: "cairn", model: "m9" } } });
    expect(state.currentModel).toBe("cairn::m9");
    // unchanged header → same object (no churn)
    const again = applyContextRingEvent(state, { type: "request/header", data: { config: { provider: "cairn", model: "m9" } } });
    expect(again).toBe(state);
  });

  it("ignores messages without reasoning or source attribution", () => {
    let state = contextRingProjectionDefinition.init();
    state = applyContextRingEvent(state, { type: "assistant/message", data: { message: { content: [{ type: "text", text: "hi" }], source: { provider: "p", model: "m" } } } });
    state = applyContextRingEvent(state, { type: "assistant/message", data: { message: { content: [{ type: "reasoning", text: "z" }] } } });
    expect(Object.keys(state.byModel)).toHaveLength(0);
  });

  it("definition wires a stable key + view passthrough", () => {
    expect(contextRingProjectionDefinition.key).toBe("contextRing");
    const state = applyContextRingEvent(contextRingProjectionDefinition.init(), msgEvent("c", "m", [{ text: "t" }]));
    expect(contextRingProjectionDefinition.wire.view(state)).toBe(state);
  });
});

describe("foldSessionUsage", () => {
  it("folds token metrics from chunk and message events", () => {
    const events = [
      {
        type: "assistant/chunk",
        data: {
          chunk: {
            type: "usage",
            usage: { inputTokens: 1200, outputTokens: 350, reasoningTokens: 150, cacheReadTokens: 400, costUsd: 0.02 },
          },
        },
      },
      {
        type: "tool/result",
        data: { message: { content: [{ type: "text", text: "1234567890" }] } },
      },
    ];

    const usage = import("./plugins/context-ring").then((m) => m.foldSessionUsage(events));
    return usage.then((res) => {
      expect(res).toBeDefined();
      expect(res?.promptTokens).toBe(1200);
      expect(res?.completionTokens).toBe(350);
      expect(res?.reasoningTokens).toBe(150);
      expect(res?.cacheReadTokens).toBe(400);
      expect(res?.costUsd).toBe(0.02);
      expect(res?.breakdown).toBeDefined();
    });
  });
});

describe("foldSessionUsage — dsh 0.2 event shapes", () => {
  // A cached mid-session request: dsh usage is DISJOINT, so the uncached
  // `inputTokens` is tiny and the real context lives in cacheReadTokens.
  const longText = (n: number) => "x".repeat(n);
  const events = [
    { type: "system/message", data: { turn: 1, step: 1, message: { role: "system", content: [{ type: "text", text: longText(4000) }], source: { kind: "system-prompt" } } } },
    { type: "request/header", data: { header: { config: { provider: "openai", model: "deepseek-chat" }, tools: [{ name: "read", description: longText(2000) }] } } },
    { type: "user/message", data: { role: "user", content: [{ type: "text", text: longText(800) }], source: { kind: "skill-catalog", form: "catalog" } } },
    { type: "user/message", data: { role: "user", content: [{ type: "text", text: longText(2000) }], source: { kind: "user" } } },
    { type: "assistant/message", data: { message: { role: "assistant", content: [{ type: "text", text: longText(400) }], source: { kind: "model", provider: "openai", model: "deepseek-chat" } }, stream: [], usage: { inputTokens: 9000, outputTokens: 100, cacheReadTokens: 0 } } },
    { type: "tool/result", data: { message: { role: "tool", content: [{ type: "text", text: longText(8000) }], source: { kind: "tool", callId: "c1" }, toolCallId: "c1" } } },
    { type: "assistant/message", data: { message: { role: "assistant", content: [{ type: "text", text: longText(400) }], source: { kind: "model", provider: "openai", model: "deepseek-chat" } }, stream: [], usage: { inputTokens: 60, outputTokens: 80, cacheReadTokens: 11000, cacheWriteTokens: 40 } } },
  ];

  it("measures context as input + cache read + cache write of the LATEST request", async () => {
    const { foldSessionUsage } = await import("./plugins/context-ring");
    const res = foldSessionUsage(events)!;
    expect(res.promptTokens).toBe(60 + 11000 + 40);
    expect(res.cacheReadTokens).toBe(11000);
    expect(res.cacheCreationTokens).toBe(40);
  });

  it("keeps conversation + tool-output slices non-zero under prompt caching", async () => {
    const { foldSessionUsage } = await import("./plugins/context-ring");
    const b = foldSessionUsage(events)!.breakdown!;
    expect(b.toolOutputs).toBe(2000);
    expect(b.conversation).toBeGreaterThan(0);
    // system prompt measured from system/message, not the 350 guess
    expect(b.systemPrompt).toBeGreaterThan(1000);
    // skill catalog injection is bucketed as skills, not conversation
    expect(b.skills).toBe(200);
  });

  it("breakdownUsageEvent marks the count as already-total (promptTokens, no inputTokens)", async () => {
    const { breakdownUsageEvent } = await import("./plugins/context-ring");
    const ev = breakdownUsageEvent(events) as { data: { chunk: { usage: Record<string, unknown> } } };
    expect(ev.data.chunk.usage.promptTokens).toBe(11100);
    expect(ev.data.chunk.usage.inputTokens).toBeUndefined();
    expect(ev.data.chunk.usage.breakdown).toBeDefined();
  });
});

describe("foldSessionTodos", () => {
  it("folds last todo/write event into todo list", () => {
    const events = [
      {
        type: "todo/write",
        data: { todos: [{ id: "1", title: "Step 1", status: "completed" }, { id: "2", title: "Step 2", status: "in_progress" }] },
      },
    ];

    return import("./plugins/context-ring").then((m) => {
      const todos = m.foldSessionTodos(events);
      expect(todos).toHaveLength(2);
      expect(todos[0]).toMatchObject({ id: "1", title: "Step 1", status: "completed" });
      expect(todos[1]).toMatchObject({ id: "2", title: "Step 2", status: "in_progress" });
    });
  });
});

