/**
 * LLM transport tests — the capability-cached seam between chat-completions and
 * the Responses API. Proves `resolveTransport` probes once, caches the result,
 * and downgrades cleanly.
 */

import { describe, it, expect, vi } from "vitest";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import {
  resolveTransport,
  readCachedMode,
  recordMode,
  markCompletionsOnly,
  probeResponses,
  isEndpointNotFound,
  COMPLETIONS_TRANSPORT,
  RESPONSES_TRANSPORT,
} from "./llm-transport";

/**
 * A mock provider that answers POST /responses (and /v1/responses) with a fixed
 * status, recording how many probe hits it received.
 */
function makeProvider(status: number): Promise<{
  baseUrl: string;
  hits: () => number;
  close: () => Promise<void>;
}> {
  let count = 0;
  const server = http.createServer((req, res) => {
    if (req.method === "POST" && (req.url === "/responses" || req.url === "/v1/responses")) {
      count++;
    }
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "probe", type: "invalid_request_error", code: "model_not_found" } }));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        baseUrl: `http://127.0.0.1:${port}/v1`,
        hits: () => count,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

describe("isEndpointNotFound", () => {
  it("treats only 404/405 as a missing route", () => {
    expect(isEndpointNotFound(404)).toBe(true);
    expect(isEndpointNotFound(405)).toBe(true);
    expect(isEndpointNotFound(400)).toBe(false);
    expect(isEndpointNotFound(401)).toBe(false);
    expect(isEndpointNotFound(422)).toBe(false);
    expect(isEndpointNotFound(200)).toBe(false);
  });
});

describe("probeResponses", () => {
  it("is false on 404/405 and true on any other status", async () => {
    const notFound = await makeProvider(404);
    expect(await probeResponses(notFound.baseUrl)).toBe(false);
    await notFound.close();

    const badModel = await makeProvider(400);
    expect(await probeResponses(badModel.baseUrl)).toBe(true);
    await badModel.close();

    const ok = await makeProvider(200);
    expect(await probeResponses(ok.baseUrl)).toBe(true);
    await ok.close();
  });

  it("is false on network failure", async () => {
    expect(await probeResponses("http://127.0.0.1:1")).toBe(false); // nothing listening
  });
});

describe("resolveTransport", () => {
  it("returns responses for OpenAI-native endpoints without probing", async () => {
    const t = await resolveTransport("https://api.openai.com");
    expect(t).toBe(RESPONSES_TRANSPORT);
    expect(readCachedMode("https://api.openai.com")).toBe("responses");
  });

  it("returns responses for Azure OpenAI preview hosts", async () => {
    const t = await resolveTransport("https://my-resource.openai.azure.com");
    expect(t).toBe(RESPONSES_TRANSPORT);
  });

  it("returns completions for local endpoints without probing", async () => {
    // Local servers (Ollama / LM Studio / llama.cpp / test mocks) don't serve
    // /responses today — resolved with no network I/O.
    const t = await resolveTransport("http://127.0.0.1:1234/v1");
    expect(t).toBe(COMPLETIONS_TRANSPORT);
    expect(readCachedMode("http://127.0.0.1:1234/v1")).toBe("completions");
  });

  it("probes an unknown non-local provider once and caches the result", async () => {
    const probe = vi.fn().mockResolvedValue(true);
    const first = await resolveTransport("https://unknown.example.com", "", probe);
    const second = await resolveTransport("https://unknown.example.com", "", probe);
    expect(first).toBe(RESPONSES_TRANSPORT);
    expect(second).toBe(RESPONSES_TRANSPORT);
    expect(probe).toHaveBeenCalledTimes(1); // probed exactly once, then cached
  });

  it("dedupes concurrent resolutions for the same base URL into one probe", async () => {
    let calls = 0;
    const probe = vi.fn(async () => {
      calls++;
      return true;
    });
    const [a, b, c] = await Promise.all([
      resolveTransport("https://concurrent.example.com", "", probe),
      resolveTransport("https://concurrent.example.com", "", probe),
      resolveTransport("https://concurrent.example.com", "", probe),
    ]);
    expect(a).toBe(RESPONSES_TRANSPORT);
    expect(b).toBe(RESPONSES_TRANSPORT);
    expect(c).toBe(RESPONSES_TRANSPORT);
    expect(calls).toBe(1); // the three callers shared one in-flight probe
  });

  it("markCompletionsOnly downgrades a previously-responses provider", async () => {
    recordMode("https://example-down.com", "responses");
    expect(readCachedMode("https://example-down.com")).toBe("responses");
    markCompletionsOnly("https://example-down.com");
    expect(readCachedMode("https://example-down.com")).toBe("completions");
    expect(await resolveTransport("https://example-down.com")).toBe(COMPLETIONS_TRANSPORT);
  });

  it("both transports expose the same endpoint + body shape contract", () => {
    expect(RESPONSES_TRANSPORT.endpoint("https://api.openai.com")).toBe(
      "https://api.openai.com/v1/responses",
    );
    expect(COMPLETIONS_TRANSPORT.endpoint("https://api.openai.com")).toBe(
      "https://api.openai.com/v1/chat/completions",
    );
    expect(COMPLETIONS_TRANSPORT.endpoint("https://opencode.ai/zen/go/v1")).toBe(
      "https://opencode.ai/zen/go/v1/chat/completions",
    );
  });
});
