/**
 * Guards patches/@earendil-works+pi-ai+0.85.1.patch (applied by patch-package
 * on postinstall). Unpatched pi-ai re-parses the whole accumulated tool-call
 * JSON on every streamed delta — O(n²) on the main process for a large write.
 * The patch (ported from deepseek-harness #4740) parses once at toolcall_end.
 * If this fails after a pi-ai bump, re-create the patch or drop it once
 * upstream pi-ai stops re-parsing per delta.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { stream as streamCompletions } from "@earendil-works/pi-ai/api/openai-completions";
import { stream as streamResponses } from "@earendil-works/pi-ai/api/openai-responses";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

/** Serve one SSE response replaying `events` as `data:` lines. */
async function sseServer(events: string[]): Promise<string> {
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const e of events) res.write(`data: ${e}\n\n`);
      res.end();
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
}

const args = { file_path: "notes.md", content: "x".repeat(2048) };
const argsJson = JSON.stringify(args);
const fragments = argsJson.match(/.{1,7}/gs) ?? [];
const context = { messages: [{ role: "user" as const, content: "hi", timestamp: 0 }] };

function model(api: "openai-completions" | "openai-responses", baseUrl: string) {
  return {
    id: "m", name: "m", api, provider: "test", baseUrl, reasoning: false, input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024,
  } as never;
}

async function collect(events: AsyncIterable<unknown>): Promise<{ partials: unknown[]; final: unknown }> {
  const partials: unknown[] = [];
  let final: unknown;
  for await (const raw of events) {
    const event = raw as { type: string; delta?: string; contentIndex?: number; partial?: { content: Array<{ type: string; arguments?: unknown }> }; toolCall?: { arguments: unknown }; error?: { errorMessage?: string } };
    if (event.type === "toolcall_delta" && (event.delta?.length ?? 0) > 0) {
      const block = event.partial?.content[event.contentIndex ?? 0];
      partials.push(block?.type === "toolCall" ? block.arguments : undefined);
    } else if (event.type === "toolcall_end") {
      final = event.toolCall?.arguments;
    } else if (event.type === "error") {
      throw new Error(event.error?.errorMessage);
    }
  }
  return { partials, final };
}

describe("streamed tool-call arguments (patched pi-ai)", () => {
  it("openai-completions parses arguments once, at the end of the call", async () => {
    const url = await sseServer([
      JSON.stringify({ choices: [{ delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "write", arguments: "" } }] }, index: 0, finish_reason: null }] }),
      ...fragments.map((f) => JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: f } }] }, index: 0, finish_reason: null }] })),
      '{"choices":[{"delta":{},"index":0,"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":3,"completion_tokens":1}}',
      "[DONE]",
    ]);
    const { partials, final } = await collect(streamCompletions(model("openai-completions", url), context, { apiKey: "test-key" }) as AsyncIterable<unknown>);
    expect(partials).toHaveLength(fragments.length);
    expect(partials.every((p) => JSON.stringify(p) === "{}")).toBe(true);
    expect(final).toEqual(args);
  });

  it("openai-responses parses arguments once, at the end of the call", async () => {
    const item = { type: "function_call", call_id: "call_1", id: "fc_1", name: "write" };
    const url = await sseServer([
      '{"type":"response.created","response":{"id":"resp_1"}}',
      JSON.stringify({ type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } }),
      ...fragments.map((f) => JSON.stringify({ type: "response.function_call_arguments.delta", output_index: 0, delta: f })),
      JSON.stringify({ type: "response.function_call_arguments.done", output_index: 0, arguments: argsJson }),
      JSON.stringify({ type: "response.output_item.done", output_index: 0, item: { ...item, arguments: argsJson } }),
      JSON.stringify({ type: "response.completed", response: { id: "resp_1", status: "completed", output: [], usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 } } }),
    ]);
    const { partials, final } = await collect(streamResponses(model("openai-responses", url), context, { apiKey: "test-key" }) as AsyncIterable<unknown>);
    expect(partials).toHaveLength(fragments.length);
    expect(partials.every((p) => JSON.stringify(p) === "{}")).toBe(true);
    expect(final).toEqual(args);
  });
});
