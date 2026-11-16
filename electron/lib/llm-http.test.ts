import { afterEach, describe, expect, it, vi } from "vitest";

import { authHeaders, fetchJson, LLM_HTTP_TIMEOUT_MS } from "./llm-http";

describe("authHeaders", () => {
  it("returns no headers without a key", () => {
    expect(authHeaders(undefined)).toEqual({});
    expect(authHeaders("")).toEqual({});
    expect(authHeaders(null)).toEqual({});
  });

  it("sends Bearer by default", () => {
    expect(authHeaders("sk-x")).toEqual({ Authorization: "Bearer sk-x" });
  });

  it("also sends x-api-key when asked", () => {
    expect(authHeaders("sk-x", { apiKeyHeader: true })).toEqual({
      Authorization: "Bearer sk-x",
      "x-api-key": "sk-x",
    });
  });
});

describe("fetchJson", () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    vi.unstubAllGlobals();
    globalThis.fetch = realFetch;
  });

  it("applies Bearer auth and merges caller headers", async () => {
    let seen: { url: unknown; init: RequestInit } | undefined;
    globalThis.fetch = (async (url: unknown, init: RequestInit) => {
      seen = { url, init };
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    await fetchJson("https://llm.test/v1/models", {
      apiKey: "sk-x",
      headers: { "Content-Type": "application/json" },
    });

    expect(seen?.url).toBe("https://llm.test/v1/models");
    expect(seen?.init.headers).toEqual({
      Authorization: "Bearer sk-x",
      "Content-Type": "application/json",
    });
  });

  it("sends both auth headers for gateway-style endpoints", async () => {
    let seenHeaders: unknown;
    globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
      seenHeaders = init.headers;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    await fetchJson("https://llm.test/v1/messages", { apiKey: "sk-x", apiKeyHeader: true });

    expect(seenHeaders).toMatchObject({
      Authorization: "Bearer sk-x",
      "x-api-key": "sk-x",
    });
  });

  it("always attaches a timeout signal (shared default)", async () => {
    expect(LLM_HTTP_TIMEOUT_MS).toBe(10_000);
    let seenSignal: AbortSignal | undefined;
    globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
      seenSignal = init.signal as AbortSignal;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    await fetchJson("https://llm.test/v1/models", { apiKey: "k" });
    expect(seenSignal).toBeDefined();
    // Sanity: the default is seconds, not milliseconds — nothing fires promptly.
    await new Promise((r) => setTimeout(r, 50));
    expect(seenSignal!.aborted).toBe(false);
  });

  it("a short timeout aborts a hung endpoint", async () => {
    globalThis.fetch = (( _url: unknown, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      })) as typeof fetch;

    await expect(fetchJson("https://llm.test/v1/models", { apiKey: "k", timeoutMs: 20 })).rejects.toThrow();
  });

  it("combines an outer signal with the timeout", async () => {
    let seenSignal: AbortSignal | undefined;
    globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
      seenSignal = init.signal as AbortSignal;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const ctrl = new AbortController();
    await fetchJson("https://llm.test/v1/models", { apiKey: "k", signal: ctrl.signal });
    expect(seenSignal!.aborted).toBe(false);
    ctrl.abort();
    expect(seenSignal!.aborted).toBe(true);
  });
});
