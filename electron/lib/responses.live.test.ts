/**
 * Responses API live test — validates the adapter (`responses.ts`) against the
 * real opencode zen Responses endpoint (`https://opencode.ai/zen/go/v1/responses`)
 * using the OCGO key.
 *
 * OPT-IN, following the repo's live-test convention (bench-endpoint.ts):
 *
 *   CAIRN_LIVE_TESTS=1 \
 *   TEST_LLM_OCGO_BASE_URL=https://opencode.ai/zen/go/v1 \
 *   TEST_LLM_OCGO_MODEL=deepseek-v4-flash \
 *   TEST_LLM_OCGO_KEY=sk-... \
 *   npx vitest run electron/lib/responses.live.test.ts
 *
 * `TEST_LLM_OCGO_MODEL` / `TEST_LLM_OCGO_KEY` are already in `.env.test`;
 * `TEST_LLM_OCGO_BASE_URL` defaults to the zen endpoint. These suites must
 * never gate a normal `npm test` / CI run.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { buildResponsesBody, consumeResponsesStream, mapMessagesToInput, parseResponsesOutput } from "./responses";
import { endpointUp, LIVE_TESTS_ENABLED } from "./bench-endpoint";
import type { OpenAIMessage } from "./llm";

const OCGO_BASE_URL = (process.env.TEST_LLM_OCGO_BASE_URL || "https://opencode.ai/zen/go/v1")
  .trim()
  .replace(/\/+$/, "");
const OCGO_MODEL = process.env.TEST_LLM_OCGO_MODEL?.trim() || "deepseek-v4-flash";
const OCGO_KEY = process.env.TEST_LLM_OCGO_KEY?.trim() || "";

const WEATHER_TOOL = {
  type: "function",
  function: {
    name: "get_weather",
    description: "Get the current weather for a location",
    parameters: {
      type: "object",
      properties: { location: { type: "string" } },
      required: ["location"],
    },
  },
};

async function postResponses(body: Record<string, unknown>): Promise<Response> {
  return fetch(`${OCGO_BASE_URL}/responses`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${OCGO_KEY}` },
    body: JSON.stringify(body),
  });
}

describe.skipIf(!LIVE_TESTS_ENABLED)("Responses API adapter (live, OCGO)", () => {
  let up = false;
  beforeAll(async () => {
    up = await endpointUp(OCGO_BASE_URL, OCGO_KEY);
  });

  const skip = () => {
    console.log(`[skip] Responses endpoint unreachable at ${OCGO_BASE_URL}. Set TEST_LLM_OCGO_* to run.`);
  };

  it("streams a text reply and reports usage + finish_reason", async () => {
    if (!up) return skip();

    const body = buildResponsesBody({
      model: OCGO_MODEL,
      messages: [
        { role: "system", content: "Reply with exactly one word." },
        { role: "user", content: "Say hello." },
      ],
      tools: [],
      maxTokens: 2048,
      temperature: 0.3,
    });

    const res = await postResponses(body);
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text().catch(() => res.statusText)}`);

    let usage: { pt: number; ct: number; rt: number } | undefined;
    const turn = await consumeResponsesStream(res.body!.getReader(), {
      onUsage: (u) => (usage = { pt: u.promptTokens, ct: u.completionTokens, rt: u.reasoningTokens }),
    });

    console.log(`\n=== text (${OCGO_MODEL}) ===\ncontent="${turn.content}"\nreasoning=${turn.reasoning.length}ch finish=${turn.finishReason}\nusage=${JSON.stringify(usage)}`);
    expect(turn.content.trim().length).toBeGreaterThan(0);
    expect(turn.finishReason).toBe("stop");
    expect(usage?.pt).toBeGreaterThan(0);
    expect(usage?.ct).toBeGreaterThan(0);
  }, 120_000);

  it("streams a function_call with parseable arguments", async () => {
    if (!up) return skip();

    const body = buildResponsesBody({
      model: OCGO_MODEL,
      messages: [
        { role: "system", content: "You must use the provided tool." },
        { role: "user", content: "Use get_weather to look up the weather in Paris." },
      ],
      tools: [WEATHER_TOOL],
      maxTokens: 2048,
      temperature: 0.3,
    });

    const res = await postResponses(body);
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text().catch(() => res.statusText)}`);

    const turn = await consumeResponsesStream(res.body!.getReader(), {});

    console.log(`\n=== tool call (${OCGO_MODEL}) ===\ntoolCalls=${JSON.stringify(turn.toolCalls)}\ncontent="${turn.content}"`);
    expect(turn.toolCalls.length).toBeGreaterThan(0);
    const call = turn.toolCalls[0];
    expect(call.function.name).toBe("get_weather");
    // Third-party Responses routers may use their own call-id scheme, so only
    // require a non-empty id (not OpenAI's `call_` prefix).
    expect(typeof call.id).toBe("string");
    expect(call.id.length).toBeGreaterThan(0);
    const args = JSON.parse(call.function.arguments);
    expect(typeof args.location).toBe("string");
  }, 120_000);

  it("runs a full multi-turn: tool call → function_call_output → final answer", async () => {
    if (!up) return skip();

    // Turn 1 — model requests the tool.
    const messages1: OpenAIMessage[] = [
      { role: "system", content: "You are a weather assistant. Use get_weather." },
      { role: "user", content: "What's the weather in Paris?" },
    ];
    const res1 = await postResponses(
      buildResponsesBody({ model: OCGO_MODEL, messages: messages1, tools: [WEATHER_TOOL], maxTokens: 2048, temperature: 0.3 }),
    );
    if (!res1.ok) throw new Error(`HTTP ${res1.status}: ${await res1.text().catch(() => res1.statusText)}`);
    const turn1 = await consumeResponsesStream(res1.body!.getReader(), {});
    expect(turn1.toolCalls.length).toBeGreaterThan(0);
    const call = turn1.toolCalls[0];

    // Feed the call + its result back the way the chat/agent loops do.
    const messages2: OpenAIMessage[] = [
      ...messages1,
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: call.id, type: "function", function: { name: call.function.name, arguments: call.function.arguments } },
        ],
      },
      { role: "tool", tool_call_id: call.id, content: "Sunny, 22C" },
    ];

    const res2 = await postResponses(
      buildResponsesBody({ model: OCGO_MODEL, messages: messages2, tools: [WEATHER_TOOL], maxTokens: 2048, temperature: 0.3 }),
    );
    if (!res2.ok) throw new Error(`HTTP ${res2.status}: ${await res2.text().catch(() => res2.statusText)}`);
    const turn2 = await consumeResponsesStream(res2.body!.getReader(), {});

    console.log(`\n=== final answer (${OCGO_MODEL}) ===\n"${turn2.content}"\ntoolCalls=${turn2.toolCalls.length}`);
    expect(turn2.toolCalls.length).toBe(0); // done calling tools
    expect(turn2.content.toLowerCase()).toMatch(/22c|sunny|weather/);
  }, 120_000);

  it("parses a non-streaming response via parseResponsesOutput (one-shot path)", async () => {
    if (!up) return skip();

    const body = buildResponsesBody({
      model: OCGO_MODEL,
      messages: [{ role: "user", content: "Say hello." }],
      tools: [],
      maxTokens: 2048,
      temperature: 0.3,
      stream: false,
    });

    const res = await postResponses(body);
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text().catch(() => res.statusText)}`);

    const parsed = parseResponsesOutput(await res.json());
    console.log(`\n=== non-streaming (${OCGO_MODEL}) ===\ncontent="${parsed.content}"\nusage=${JSON.stringify(parsed.usage)}`);
    expect(parsed.content.trim().length).toBeGreaterThan(0);
    expect(parsed.usage?.promptTokens).toBeGreaterThan(0);
    expect(parsed.usage?.completionTokens).toBeGreaterThan(0);
  }, 120_000);

  it("preserves call_id linkage when mapping multi-turn history to input items", () => {
    // Pure sanity check that the exact messages the loop produces map to
    // function_call / function_call_output items with the SAME call_id.
    const { input } = mapMessagesToInput([
      { role: "assistant", content: null, tool_calls: [{ id: "call_123", type: "function", function: { name: "get_weather", arguments: '{"location":"Paris"}' } }] },
      { role: "tool", tool_call_id: "call_123", content: "Sunny" },
    ]);
    expect(input).toEqual([
      { type: "function_call", call_id: "call_123", name: "get_weather", arguments: '{"location":"Paris"}' },
      { type: "function_call_output", call_id: "call_123", output: "Sunny" },
    ]);
  });
});
