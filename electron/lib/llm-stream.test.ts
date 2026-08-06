/**
 * Unit tests for the shared LLM streaming / message-preparation layer
 * (`electron/lib/llm-stream.ts`), which both the chat loop and the agent loop
 * consume so their SSE parsing and reasoning handling can never diverge.
 */

import { describe, it, expect } from "vitest";
import { consumeAssistantStream, failToolCallsFromTruncatedMessage, prepareContextMessages, resolveSystemRole, supportsDeveloperRole } from "./llm-stream";

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
});

describe("prepareContextMessages", () => {
  it("prepends the system prompt as a role:system message and keeps normal turns", async () => {
    const out = await prepareContextMessages({
      systemPrompt: "You are a helper.",
      currentModelKey: "a::m",
      messages: [
        { role: "user", content: "Hi" },
        { role: "assistant", content: "Hello" },
      ],
    });

    expect(out).toEqual([
      { role: "system", content: "You are a helper." },
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hello" },
    ]);
  });

  it("round-trips reasoning under its native field for the same model", async () => {
    const out = await prepareContextMessages({
      systemPrompt: "sys",
      currentModelKey: "a::m",
      messages: [
        { role: "assistant", content: "", reasoning: "THOUGHTS", reasoningField: "reasoning_content", reasoningModel: "a::m" },
      ],
    });

    expect(out).toHaveLength(2); // system + assistant
    expect(out[1]).toMatchObject({ role: "assistant", reasoning_content: "THOUGHTS" });
    // internal metadata keys are gone
    expect(JSON.stringify(out[1])).not.toContain("reasoningModel");
  });

  it("converts reasoning from a different model to plain text (pi behaviour)", async () => {
    const out = await prepareContextMessages({
      systemPrompt: "sys",
      currentModelKey: "a::m",
      messages: [
        { role: "assistant", content: "I did things.", reasoning: "OLD_THOUGHTS", reasoningField: "reasoning", reasoningModel: "b::n" },
      ],
    });

    expect(out).toHaveLength(2);
    // The reasoning is NOT sent as a foreign field — it becomes text content
    expect(JSON.stringify(out[1])).not.toContain("\"reasoning\":\"OLD_THOUGHTS\"");
    expect(JSON.stringify(out[1])).not.toContain("reasoningField");
    expect(out[1]).toMatchObject({ role: "assistant", content: "I did things.\n\nOLD_THOUGHTS" });
  });

  it("appends cross-model reasoning to content even when the reply was otherwise empty", async () => {
    const out = await prepareContextMessages({
      systemPrompt: "sys",
      currentModelKey: "a::m",
      messages: [
        { role: "assistant", content: "", reasoning: "ONLY_THOUGHTS", reasoningField: "reasoning_content", reasoningModel: "b::n" },
      ],
    });

    expect(out).toHaveLength(2);
    expect(out[1]).toMatchObject({ role: "assistant", content: "ONLY_THOUGHTS" });
  });

  it("strips bare reasoning with no round-trip metadata", async () => {
    const out = await prepareContextMessages({
      systemPrompt: "sys",
      currentModelKey: "a::m",
      messages: [
        { role: "assistant", content: "Hi", reasoning: "LEGACY_THOUGHTS" },
      ],
    });

    expect(JSON.stringify(out[1])).not.toContain("LEGACY_THOUGHTS");
    expect(out[1]).toMatchObject({ role: "assistant", content: "Hi" });
  });

  it("drops empty assistant turns that would poison the request", async () => {
    const out = await prepareContextMessages({
      systemPrompt: "sys",
      currentModelKey: "a::m",
      messages: [
        { role: "assistant", content: "" },
        { role: "assistant", content: "kept" },
      ],
    });

    expect(out).toHaveLength(2); // system + kept assistant
    expect(out[1]).toMatchObject({ role: "assistant", content: "kept" });
  });

  it("uses the requested system role for the prepended message", async () => {
    const out = await prepareContextMessages({
      systemPrompt: "sys",
      systemRole: "developer",
      currentModelKey: "a::m",
      messages: [{ role: "user", content: "Hi" }],
    });

    expect(out[0]).toEqual({ role: "developer", content: "sys" });
  });
});

describe("resolveSystemRole (pi parity)", () => {
  it("uses developer for reasoning models on standard OpenAI-compatible providers", () => {
    expect(resolveSystemRole({ isReasoningModel: true, baseUrl: "https://api.openai.com/v1", provider: "openai", modelId: "gpt-5" }))
      .toBe("developer");
    expect(resolveSystemRole({ isReasoningModel: true, baseUrl: "https://example.com/v1", modelId: "o3" }))
      .toBe("developer");
  });

  it("stays system for non-reasoning models", () => {
    expect(resolveSystemRole({ isReasoningModel: false, baseUrl: "https://api.openai.com/v1" }))
      .toBe("system");
    expect(resolveSystemRole({ baseUrl: "https://api.openai.com/v1" }))
      .toBe("system");
  });

  it("stays system on the denylisted providers (pi detectCompat)", () => {
    expect(resolveSystemRole({ isReasoningModel: true, baseUrl: "https://api.deepseek.com/v1", modelId: "deepseek-r1" }))
      .toBe("system");
    expect(resolveSystemRole({ isReasoningModel: true, baseUrl: "https://integrate.api.nvidia.com/v1" }))
      .toBe("system");
    expect(resolveSystemRole({ isReasoningModel: true, baseUrl: "https://api.together.ai/v1" }))
      .toBe("system");
    expect(resolveSystemRole({ isReasoningModel: true, baseUrl: "http://127.0.0.1:8080/v1", provider: "localllm" }))
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

  it("exposes the denylist predicate for consumers", () => {
    expect(supportsDeveloperRole({ baseUrl: "https://api.openai.com/v1" })).toBe(true);
    expect(supportsDeveloperRole({ baseUrl: "https://api.deepseek.com/v1" })).toBe(false);
  });
});

describe("failToolCallsFromTruncatedMessage", () => {
  it("synthesizes a stable id for tool calls whose id chunk never arrived", () => {
    const starts: string[] = [];
    const ends: string[] = [];
    const results = failToolCallsFromTruncatedMessage(
      [
        { id: "", function: { name: "ls" } },
        { id: "call_ok", function: { name: "ls" } },
      ],
      {
        maxTokens: undefined,
        labelFor: (n) => n,
        emitStart: (name, label, callId) => starts.push(`${name}:${callId}`),
        emitEnd: (name, label, ok, output, callId) => ends.push(`${name}:${callId}:${ok}`),
      },
    );

    // The id-less tool got a synthesized id, used for both the chip and result.
    expect(starts).toHaveLength(2);
    expect(results[0].tool_call_id).toBe("ls:truncated:0");
    expect(starts[0]).toBe("ls:ls:truncated:0");
    expect(results[1].tool_call_id).toBe("call_ok");
    expect(results.every((r) => r.content.includes("not executed"))).toBe(true);
  });
});
