/**
 * Responses API adapter tests — prove the migration is feasible before wiring
 * the adapter into the chat/agent loops.
 *
 * Two layers:
 *   1. Pure conversion (`mapMessagesToInput`, `buildResponsesBody`) — the
 *      Chat Completions shapes Cairn already produces translate cleanly.
 *   2. Streaming (`consumeResponsesStream`) — a mock server emits Responses-API
 *      SSE and we assert the SAME `StreamedTurn` shape the loops already
 *      consume comes out, including tool calls and usage.
 */

import { describe, it, expect } from "vitest";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import {
  isResponsesEndpoint,
  mapToolToResponses,
  mapMessagesToInput,
  roundTripReasoningItem,
  buildResponsesBody,
  consumeResponsesStream,
  parseResponsesOutput,
  responsesToCompletionsShape,
} from "./responses";
import type { OpenAIMessage } from "./llm";

// ── helpers ───────────────────────────────────────────────────────────────────

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

/** Wrap a Responses event object into a single `data:` SSE frame. */
function frame(event: Record<string, unknown>): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

/** A minimal function_call item for output_item.added. */
function fnCallAdded(idx: number, callId: string, name: string): Record<string, unknown> {
  return {
    type: "response.output_item.added",
    output_index: idx,
    item: { id: `fc_${callId}`, type: "function_call", call_id: callId, name, arguments: "" },
  };
}

/** A mock server that replies with a fixed Responses SSE body and records the request. */
function makeResponsesServer(body: string): Promise<{
  url: string;
  close: () => Promise<void>;
  requestBody: () => Record<string, unknown>;
}> {
  let captured: Record<string, unknown> = {};
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      try {
        captured = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      } catch {
        captured = {};
      }
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      res.end(body);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(() => r())),
        requestBody: () => captured,
      });
    });
  });
}

// ── endpoint gating ───────────────────────────────────────────────────────────

describe("isResponsesEndpoint", () => {
  it("accepts OpenAI native + Azure, rejects every OpenAI-compatible provider", () => {
    expect(isResponsesEndpoint("https://api.openai.com")).toBe(true);
    expect(isResponsesEndpoint("https://api.openai.com/v1")).toBe(true);
    expect(isResponsesEndpoint("https://foo.openai.azure.com")).toBe(true);

    expect(isResponsesEndpoint("https://openrouter.ai/api")).toBe(false);
    expect(isResponsesEndpoint("http://localhost:1234/v1")).toBe(false);
    expect(isResponsesEndpoint("https://api-gateway.merge.dev/v1/openai")).toBe(false);
    expect(isResponsesEndpoint("https://api.together.xyz")).toBe(false);
  });
});

// ── request-body conversion ───────────────────────────────────────────────────

describe("mapToolToResponses", () => {
  it("flattens the Chat Completions function wrapper", () => {
    const cc = {
      type: "function",
      function: { name: "ls", description: "list files", parameters: { type: "object" } },
    };
    expect(mapToolToResponses(cc)).toEqual({
      type: "function",
      name: "ls",
      description: "list files",
      parameters: { type: "object" },
    });
  });

  it("also accepts an already-internal shape (idempotent)", () => {
    const internal = { type: "function", name: "ls", parameters: { type: "object" } };
    expect(mapToolToResponses(internal)).toEqual({
      type: "function",
      name: "ls",
      parameters: { type: "object" },
    });
  });
});

describe("mapMessagesToInput", () => {
  it("hoists system/developer guidance into instructions", () => {
    const { instructions, input } = mapMessagesToInput([
      { role: "system", content: "You are a helper." },
      { role: "user", content: "Hi" },
    ]);
    expect(instructions).toBe("You are a helper.");
    expect(input).toEqual([{ type: "message", role: "user", content: "Hi" }]);
  });

  it("turns assistant tool_calls + tool results into call-linked items", () => {
    const messages: OpenAIMessage[] = [
      { role: "user", content: "list files" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "ls", arguments: '{"path":"."}' } },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "file.txt" },
    ];

    const { input } = mapMessagesToInput(messages);
    expect(input).toEqual([
      { type: "message", role: "user", content: "list files" },
      { type: "function_call", call_id: "call_1", name: "ls", arguments: '{"path":"."}' },
      { type: "function_call_output", call_id: "call_1", output: "file.txt" },
    ]);
  });

  it("preserves assistant text alongside its tool calls", () => {
    const messages: OpenAIMessage[] = [
      {
        role: "assistant",
        content: "Let me look.",
        tool_calls: [{ id: "c2", type: "function", function: { name: "ls", arguments: "{}" } }],
      },
    ];
    const { input } = mapMessagesToInput(messages);
    expect(input).toEqual([
      { type: "message", role: "assistant", content: "Let me look." },
      { type: "function_call", call_id: "c2", name: "ls", arguments: "{}" },
    ]);
  });

  it("converts multimodal content parts (text/image/document) to Responses input parts", () => {
    const { input } = mapMessagesToInput([
      {
        role: "user",
        content: [
          { type: "text", text: "What's in this image and PDF?" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
          { type: "document", source: { type: "base64", media_type: "application/pdf", data: "cGRmYnl0ZXM=" } },
        ],
      } as unknown as OpenAIMessage,
    ]);

    expect(input).toEqual([
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "What's in this image and PDF?" },
          { type: "input_image", image_url: "data:image/png;base64,AAAA" },
          { type: "input_file", filename: "document.pdf", file_data: "data:application/pdf;base64,cGRmYnl0ZXM=" },
        ],
      },
    ]);
  });

  it("replays reasoning items before the assistant message (same-model round-trip)", () => {
    const { input } = mapMessagesToInput([
      {
        role: "assistant",
        content: "The answer is 42.",
        reasoningItems: [
          { id: "rs_1", type: "reasoning", encrypted_content: "enc", summary: [], content: [] },
        ],
      },
    ] as unknown as OpenAIMessage[]);

    expect(input).toEqual([
      { type: "reasoning", id: "rs_1", encrypted_content: "enc" },
      { type: "message", role: "assistant", content: "The answer is 42." },
    ]);
  });
});

describe("roundTripReasoningItem", () => {
  it("preserves content, summary, and encrypted_content; drops status; skips empty items", () => {
    expect(roundTripReasoningItem({ id: "rs_1", type: "reasoning", status: "completed", encrypted_content: "enc", summary: [], content: [{ type: "reasoning_text", text: "secret" }] }))
      .toEqual({ type: "reasoning", id: "rs_1", content: [{ type: "reasoning_text", text: "secret" }], encrypted_content: "enc" });

    expect(roundTripReasoningItem({ id: "rs_2", type: "reasoning", summary: [{ type: "summary_text", text: "condensed" }], content: [] }))
      .toEqual({ type: "reasoning", id: "rs_2", summary: [{ type: "summary_text", text: "condensed" }] });

    // Raw content only (third-party router) → still round-tripped now.
    expect(roundTripReasoningItem({ id: "rs_3", type: "reasoning", content: [{ type: "reasoning_text", text: "secret" }], summary: [] }))
      .toEqual({ type: "reasoning", id: "rs_3", content: [{ type: "reasoning_text", text: "secret" }] });

    // Nothing round-trippable → null.
    expect(roundTripReasoningItem({ id: "rs_4", type: "reasoning", content: [], summary: [] }))
      .toBeNull();
  });
});

describe("buildResponsesBody", () => {
  it("maps messages, tools, and token fields to the Responses shape", () => {
    const body = buildResponsesBody({
      model: "gpt-5.6",
      messages: [
        { role: "system", content: "You are a helper." },
        { role: "user", content: "Hi" },
      ],
      tools: [
        { type: "function", function: { name: "ls", description: "list", parameters: {} } },
      ],
      maxTokens: 4096,
      temperature: 0.3,
    });

    expect(body).toEqual({
      model: "gpt-5.6",
      instructions: "You are a helper.",
      input: [{ type: "message", role: "user", content: "Hi" }],
      tools: [{ type: "function", name: "ls", description: "list", parameters: {} }],
      max_output_tokens: 4096,
      temperature: 0.3,
      stream: true,
      include: ["reasoning.encrypted_content"],
    });
  });

  it("omits max_output_tokens when Auto (0) so no tiny default is sent", () => {
    const body = buildResponsesBody({ model: "m", messages: [], tools: [], maxTokens: 0 });
    expect(body).not.toHaveProperty("max_output_tokens");
  });

  it("nests reasoning effort + summary under reasoning (not reasoning_effort)", () => {
    const body = buildResponsesBody({
      model: "gpt-5.6",
      messages: [],
      tools: [],
      reasoningEffort: "low",
      reasoningSummary: "concise",
    });
    expect(body).not.toHaveProperty("reasoning_effort");
    expect(body).toMatchObject({ reasoning: { effort: "low", summary: "concise" } });

    // No reasoning fields → no `reasoning` key at all.
    const plain = buildResponsesBody({ model: "m", messages: [], tools: [] });
    expect(plain).not.toHaveProperty("reasoning");
  });
});

// ── streaming conversion ──────────────────────────────────────────────────────

describe("consumeResponsesStream", () => {
  it("accumulates text + reasoning and reports usage + finish reason", async () => {
    const events = [
      frame({ type: "response.created", response: { id: "resp_1" } }),
      frame({ type: "response.output_text.delta", delta: "Hel" }),
      frame({ type: "response.output_text.delta", delta: "lo" }),
      frame({ type: "response.reasoning_text.delta", delta: "think" }),
      frame({
        type: "response.completed",
        response: {
          status: "completed",
          usage: {
            input_tokens: 12,
            output_tokens: 7,
            output_tokens_details: { reasoning_tokens: 3 },
            input_tokens_details: { cached_tokens: 4 },
            total_tokens: 19,
          },
        },
      }),
    ];

    let usage: { pt: number; ct: number; rt: number; cacheRead: number } | undefined;
    const turn = await consumeResponsesStream(
      sseReader(...events),
      { onUsage: (u) => (usage = { pt: u.promptTokens, ct: u.completionTokens, rt: u.reasoningTokens, cacheRead: u.cacheReadTokens }) },
    );

    expect(turn.content).toBe("Hello");
    expect(turn.reasoning).toBe("think");
    expect(turn.reasoningField).toBe("reasoning");
    expect(turn.finishReason).toBe("stop");
    expect(turn.toolCalls).toHaveLength(0);
    expect(usage).toEqual({ pt: 12, ct: 7, rt: 3, cacheRead: 4 });
  });

  it("maps max_output_tokens truncation to finish_reason length", async () => {
    const events = [
      frame({ type: "response.output_text.delta", delta: "partial" }),
      frame({
        type: "response.incomplete",
        response: {
          status: "incomplete",
          incomplete_details: { reason: "max_output_tokens" },
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      }),
    ];
    const turn = await consumeResponsesStream(sseReader(...events), {});
    expect(turn.finishReason).toBe("length");
  });

  it("captures reasoning summary separately from raw reasoning", async () => {
    const events = [
      frame({ type: "response.reasoning_text.delta", delta: "full trace" }),
      frame({ type: "response.reasoning_summary_text.delta", delta: "condensed" }),
      frame({ type: "response.completed", response: { status: "completed", usage: {} } }),
    ];
    const summaries: string[] = [];
    const turn = await consumeResponsesStream(sseReader(...events), {
      onSummary: (d) => summaries.push(d),
    });

    expect(turn.reasoning).toBe("full trace");
    expect(turn.reasoningSummary).toBe("condensed");
    expect(turn.reasoningField).toBe("reasoning"); // summary does NOT clobber the reasoning field
    expect(summaries).toEqual(["condensed"]);
  });

  it("falls back to the completed output's reasoning.summary when nothing streamed", async () => {
    const events = [
      frame({ type: "response.reasoning_text.delta", delta: "trace" }),
      frame({
        type: "response.completed",
        response: {
          status: "completed",
          usage: {},
          output: [
            { type: "reasoning", summary: [{ type: "summary_text", text: "from completed" }] },
            { type: "message", content: [{ type: "output_text", text: "hi" }] },
          ],
        },
      }),
    ];
    const turn = await consumeResponsesStream(sseReader(...events), {});
    expect(turn.reasoningSummary).toBe("from completed");
  });

  it("buffers a function_call item + argument deltas and fires onToolPending", async () => {
    const pending: Array<{ name: string; callId: string }> = [];
    const events = [
      frame(fnCallAdded(1, "call_1", "ls")),
      frame({ type: "response.function_call_arguments.delta", output_index: 1, item_id: "fc_call_1", delta: '{"path":' }),
      frame({ type: "response.function_call_arguments.delta", output_index: 1, item_id: "fc_call_1", delta: '"."}' }),
      frame({ type: "response.function_call_arguments.done", output_index: 1, item_id: "fc_call_1", arguments: '{"path":"."}' }),
      frame({ type: "response.completed", response: { status: "completed", usage: {} } }),
    ];

    const turn = await consumeResponsesStream(
      sseReader(...events),
      { onToolPending: (name, callId) => pending.push({ name, callId }) },
    );

    expect(turn.toolCalls).toHaveLength(1);
    expect(turn.toolCalls[0]).toMatchObject({
      id: "call_1",
      type: "function",
      function: { name: "ls", arguments: '{"path":"."}' },
    });
    expect(turn.toolCallIndexes).toEqual([1]);
    expect(pending).toEqual([{ name: "ls", callId: turn.streamCallIds.get(1) }]);
  });

  it("reconstructs the full request over the wire and parses the Responses reply end-to-end", async () => {
    const sse = [
      frame(fnCallAdded(0, "call_9", "grep")),
      frame({ type: "response.function_call_arguments.delta", output_index: 0, item_id: "fc_call_9", delta: '{"pattern":"foo"}' }),
      frame({ type: "response.function_call_arguments.done", output_index: 0, item_id: "fc_call_9", arguments: '{"pattern":"foo"}' }),
      frame({ type: "response.output_text.delta", delta: "found it" }),
      frame({ type: "response.completed", response: { status: "completed", usage: { input_tokens: 9, output_tokens: 3 } } }),
    ].join("");
    const server = await makeResponsesServer(sse);

    const messages: OpenAIMessage[] = [
      { role: "system", content: "You are a coder." },
      { role: "user", content: "find foo" },
    ];
    const body = buildResponsesBody({
      model: "gpt-5.6",
      messages,
      tools: [{ type: "function", function: { name: "grep", description: "search", parameters: {} } }],
      maxTokens: 4096,
      temperature: 0.3,
    });

    const res = await fetch(`${server.url}/responses`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(res.ok).toBe(true);

    const reader = res.body!.getReader();
    const turn = await consumeResponsesStream(reader, {});

    // The wire body came out in Responses shape…
    const sent = server.requestBody();
    expect(sent).toEqual(body);
    expect(sent.instructions).toBe("You are a coder.");
    expect(sent.tools).toEqual([{ type: "function", name: "grep", description: "search", parameters: {} }]);

    // …and the reply parsed into the same StreamedTurn the loops already consume.
    expect(turn.content).toBe("found it");
    expect(turn.toolCalls).toHaveLength(1);
    expect(turn.toolCalls[0].function.name).toBe("grep");
    expect(turn.toolCalls[0].function.arguments).toBe('{"pattern":"foo"}');

    await server.close();
  });
});

// ── non-streaming output conversion ──────────────────────────────────────────

describe("parseResponsesOutput", () => {
  it("extracts output_text content, reasoning summary, and usage", () => {
    const parsed = parseResponsesOutput({
      output: [
        { type: "reasoning", summary: [{ type: "summary_text", text: "condensed" }] },
        { type: "message", content: [{ type: "output_text", text: "Hello " }, { type: "output_text", text: "world" }] },
      ],
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        input_tokens_details: { cached_tokens: 3 },
        output_tokens_details: { reasoning_tokens: 2 },
      },
    });

    expect(parsed.content).toBe("Hello world");
    expect(parsed.reasoningSummary).toBe("condensed");
    expect(parsed.usage).toMatchObject({ promptTokens: 10, completionTokens: 5, reasoningTokens: 2, cacheReadTokens: 3 });
  });

  it("handles an empty body gracefully", () => {
    const parsed = parseResponsesOutput({});
    expect(parsed.content).toBe("");
    expect(parsed.reasoningSummary).toBe("");
    expect(parsed.usage).toBeUndefined();
  });
});

describe("responsesToCompletionsShape", () => {
  it("normalises function_call items and usage into the Chat Completions shape", () => {
    const shaped = responsesToCompletionsShape({
      output: [
        { type: "message", content: [{ type: "output_text", text: "calling tool" }] },
        { type: "function_call", call_id: "call_1", name: "grep", arguments: '{"pattern":"x"}' },
      ],
      usage: {
        input_tokens: 9,
        output_tokens: 4,
        input_tokens_details: { cached_tokens: 2 },
        output_tokens_details: { reasoning_tokens: 1 },
      },
    }) as {
      choices: Array<{ message: { content: string; tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }> } }>;
      usage: { prompt_tokens: number; completion_tokens: number; completion_tokens_details: { reasoning_tokens: number }; prompt_tokens_details: { cached_tokens: number } };
    };

    expect(shaped.choices[0].message.content).toBe("calling tool");
    expect(shaped.choices[0].message.tool_calls).toEqual([
      { id: "call_1", type: "function", function: { name: "grep", arguments: '{"pattern":"x"}' } },
    ]);
    expect(shaped.usage.prompt_tokens).toBe(9);
    expect(shaped.usage.completion_tokens_details.reasoning_tokens).toBe(1);
    expect(shaped.usage.prompt_tokens_details.cached_tokens).toBe(2);
  });
});
