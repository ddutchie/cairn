/**
 * Unit tests for the shared LLM streaming layer (`electron/lib/llm-stream.ts`) —
 * SSE parsing, system-role resolution, and request-body shaping.
 */

import { describe, it, expect } from "vitest";
import { consumeAssistantStream, resolveSystemRole, buildChatCompletionsBody } from "./llm-stream";

function sseReader(...chunks: string[]): ReadableStreamDefaultReader<Uint8Array> {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
  return stream.getReader();
}

describe("consumeAssistantStream", () => {
  it("accumulates content, reasoning + field, and finish_reason", async () => {
    const turn = await consumeAssistantStream(
      sseReader(
        `data: ${JSON.stringify({ choices: [{ delta: { content: "Hel" } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ delta: { content: "lo", reasoning_content: "think" } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "ing" } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`,
        "data: [DONE]\n\n",
      ),
      {},
    );

    expect(turn.content).toBe("Hello");
    expect(turn.reasoning).toBe("thinking");
    expect(turn.reasoningField).toBe("reasoning_content");
    expect(turn.finishReason).toBe("stop");
    expect(turn.toolCalls).toHaveLength(0);
  });

  it("buffers tool-call arguments split across chunks and fires onToolPending", async () => {
    const pending: Array<{ name: string; callId: string }> = [];
    const turn = await consumeAssistantStream(
      sseReader(
        `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "ls", arguments: "" } }] } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "{\"path\":" } }] } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "\".\"}" } }] } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })}\n\n`,
        "data: [DONE]\n\n",
      ),
      { onToolPending: (name, callId) => pending.push({ name, callId }) },
    );

    expect(turn.toolCalls).toHaveLength(1);
    expect(turn.toolCalls[0].function.name).toBe("ls");
    expect(turn.toolCalls[0].function.arguments).toBe('{"path":"."}');
    expect(turn.toolCallIndexes).toEqual([0]);
    expect(turn.streamCallIds.get(0)).toBeDefined();
    expect(pending).toHaveLength(1);
    expect(pending[0].name).toBe("ls");
    expect(pending[0].callId).toBe(turn.streamCallIds.get(0));
  });

  it("reports usage via onUsage and captures a null finish_reason when the stream just ends", async () => {
    let usage: { promptTokens: number; completionTokens: number } | undefined;
    const turn = await consumeAssistantStream(
      sseReader(
        `data: ${JSON.stringify({ choices: [{ delta: { content: "x" } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\n`,
        "data: [DONE]\n\n",
      ),
      { onUsage: (u) => { usage = { promptTokens: u.promptTokens, completionTokens: u.completionTokens }; } },
    );

    expect(usage).toEqual({ promptTokens: 10, completionTokens: 5 });
    expect(turn.content).toBe("x");
    expect(turn.finishReason).toBeNull();
  });

  it("synthesizes UNIQUE ids for truncated tool calls across turns (no duplicate tool_call_id)", async () => {
    const sseForTruncatedCall = () =>
      sseReader(
        `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "ls", arguments: "" } }] } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "{\"pat" } }] } }], finish_reason: "length" })}\n\n`,
        "data: [DONE]\n\n",
      );

    const first = await consumeAssistantStream(sseForTruncatedCall(), {});
    const second = await consumeAssistantStream(sseForTruncatedCall(), {});

    expect(first.toolCalls).toHaveLength(1);
    expect(second.toolCalls).toHaveLength(1);
    // Both calls lost their id chunk → both must be synthesized, never colliding.
    expect(first.toolCalls[0].id).not.toBe(second.toolCalls[0].id);
    expect(first.toolCalls[0].id.length).toBeGreaterThan(0);
  });
});

describe("resolveSystemRole (pi parity)", () => {
  it("uses developer for reasoning models on known-good OpenAI/Azure endpoints", () => {
    expect(resolveSystemRole({ isReasoningModel: true, baseUrl: "https://api.openai.com/v1", provider: "openai", modelId: "gpt-5" }))
      .toBe("developer");
    expect(resolveSystemRole({ isReasoningModel: true, baseUrl: "https://myres.openai.azure.com/openai/deployments/gpt-5", provider: "azure", modelId: "gpt-5" }))
      .toBe("developer");
  });

  it("stays system on unknown/custom endpoints (they may 400 on the developer role)", () => {
    expect(resolveSystemRole({ isReasoningModel: true, baseUrl: "https://example.com/v1", modelId: "o3" }))
      .toBe("system");
    expect(resolveSystemRole({ isReasoningModel: true, baseUrl: "https://api.deepseek.com/v1", modelId: "deepseek-r1" }))
      .toBe("system");
    expect(resolveSystemRole({ isReasoningModel: true, baseUrl: "https://integrate.api.nvidia.com/v1" }))
      .toBe("system");
    expect(resolveSystemRole({ isReasoningModel: true, baseUrl: "https://api.together.ai/v1" }))
      .toBe("system");
    expect(resolveSystemRole({ isReasoningModel: true, baseUrl: "http://127.0.0.1:8080/v1", provider: "localllm" }))
      .toBe("system");
  });

  it("stays system for non-reasoning models", () => {
    expect(resolveSystemRole({ isReasoningModel: false, baseUrl: "https://api.openai.com/v1" }))
      .toBe("system");
    expect(resolveSystemRole({ baseUrl: "https://api.openai.com/v1" }))
      .toBe("system");
  });

  it("gives OpenRouter the developer role only for anthropic/openai models", () => {
    expect(resolveSystemRole({ isReasoningModel: true, baseUrl: "https://openrouter.ai/api/v1", modelId: "anthropic/claude-sonnet-4" }))
      .toBe("developer");
    expect(resolveSystemRole({ isReasoningModel: true, baseUrl: "https://openrouter.ai/api/v1", modelId: "openai/gpt-5" }))
      .toBe("developer");
    expect(resolveSystemRole({ isReasoningModel: true, baseUrl: "https://openrouter.ai/api/v1", modelId: "deepseek/deepseek-r1" }))
      .toBe("system");
  });
});

describe("buildChatCompletionsBody reasoning_effort", () => {
  it("includes reasoning_effort when provided", () => {
    const body = buildChatCompletionsBody({ model: "m", messages: [], tools: [], maxTokens: 1000, temperature: 0.3, reasoningEffort: "none" });
    expect(body.reasoning_effort).toBe("none");
  });
  it("omits reasoning_effort when undefined (the non-reasoning fallback)", () => {
    const body = buildChatCompletionsBody({ model: "m", messages: [], tools: [], maxTokens: 1000, temperature: 0.3 });
    expect(body.reasoning_effort).toBeUndefined();
    const retry = buildChatCompletionsBody({ model: "m", messages: [], tools: [], maxTokens: 1000, temperature: 0.3, reasoningEffort: undefined });
    expect(retry.reasoning_effort).toBeUndefined();
  });
});
