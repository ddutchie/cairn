/**
 * runOneShotWithContext: `ctx.llm.stream()` reports a failed request as a
 * terminal `finish` chunk (reason "error" / "aborted") rather than throwing,
 * so the helper must turn that into a rejection instead of resolving "".
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Context } from "@deepseek-ai/cordis";

const { recordUsageMock } = vi.hoisted(() => ({ recordUsageMock: vi.fn() }));

vi.mock("./run-cordis-loop", () => ({ getContext: vi.fn(), ensureAgentAiAdapter: vi.fn(async () => {}) }));
vi.mock("./ctx-augment", () => ({}));
vi.mock("./host-store", () => ({ recordUsage: recordUsageMock }));

import { runOneShotWithContext } from "./one-shot";

type Chunk = Record<string, unknown> & { type: string };

function ctxStreaming(chunks: Chunk[], onYield?: (i: number) => void): Context {
  return {
    llm: {
      async *stream() {
        for (let i = 0; i < chunks.length; i++) {
          onYield?.(i);
          yield chunks[i];
        }
      },
    },
  } as unknown as Context;
}

const opts = {
  systemPrompt: "sys",
  userPrompt: "user",
  config: { baseUrl: "http://127.0.0.1:9", model: "m", apiKey: "" },
  source: "prd",
};

const failure = (kind: "error" | "aborted", message: string, code = "NETWORK") =>
  ({ type: "finish", reason: { kind, failure: { message, code } } });

describe("runOneShotWithContext", () => {
  beforeEach(() => { recordUsageMock.mockReset(); });

  it("returns the streamed text on a normal finish", async () => {
    const ctx = ctxStreaming([
      { type: "text-delta", index: 0, text: "Hello " },
      { type: "text-delta", index: 0, text: "world" },
      { type: "usage", usage: { inputTokens: 3, outputTokens: 2 } },
      { type: "finish", reason: { kind: "stop" } },
    ]);
    await expect(runOneShotWithContext(ctx, opts)).resolves.toBe("Hello world");
    expect(recordUsageMock).toHaveBeenCalledWith(expect.objectContaining({ promptTokens: 3, completionTokens: 2 }));
  });

  it("rejects with the provider message when the request fails", async () => {
    const ctx = ctxStreaming([failure("error", "connect ECONNREFUSED 127.0.0.1:9")]);
    await expect(runOneShotWithContext(ctx, opts)).rejects.toThrow("connect ECONNREFUSED 127.0.0.1:9");
  });

  it("rejects on an empty completion classified as EMPTY_RESPONSE", async () => {
    const ctx = ctxStreaming([failure("error", "The model returned an empty response.", "EMPTY_RESPONSE")]);
    await expect(runOneShotWithContext(ctx, opts)).rejects.toThrow("empty response");
  });

  it("rejects on a provider-side abort, falling back to a generic message", async () => {
    const ctx = ctxStreaming([failure("aborted", "")]);
    await expect(runOneShotWithContext(ctx, opts)).rejects.toThrow("The model request was aborted.");
  });

  it("still records usage for a failed request", async () => {
    const ctx = ctxStreaming([
      { type: "usage", usage: { inputTokens: 10, outputTokens: 0 } },
      failure("error", "rate limited", "RATE_LIMIT"),
    ]);
    await expect(runOneShotWithContext(ctx, opts)).rejects.toThrow("rate limited");
    expect(recordUsageMock).toHaveBeenCalledWith(expect.objectContaining({ promptTokens: 10 }));
  });

  it("resolves with partial text when the caller aborts", async () => {
    const ac = new AbortController();
    const ctx = ctxStreaming(
      [{ type: "text-delta", index: 0, text: "partial" }, failure("aborted", "aborted by caller")],
      (i) => { if (i === 1) ac.abort(); },
    );
    await expect(runOneShotWithContext(ctx, { ...opts, signal: ac.signal })).resolves.toBe("partial");
  });
});
