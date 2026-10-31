import { isRetryableAssistantError, retryDelayMs as piRetryDelayMs } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { abortableSleep, DEFAULT_RETRY, isRetryableErrorMessage, retryDelayMs, withJitter } from "./retry";

const CORPUS = [
  "503 Service Unavailable", "429 Too Many Requests", "rate_limit_exceeded", "Overloaded", "fetch failed",
  "getaddrinfo ENOTFOUND api.example.com", "socket hang up", "request timed out", "stream ended before message_stop",
  "Provider returned error", "ResourceExhausted: try later", "You can retry your request",
  "insufficient_quota", "Monthly usage limit reached", "billing hard limit reached 429", "quota exceeded (503)",
  "401 invalid api key", "400 bad request: unknown parameter", "context length exceeded", "model not found", "",
];

describe("retry classification", () => {
  it("agrees with pi-ai on a corpus (drift check when pi-ai is upgraded)", () => {
    for (const errorMessage of CORPUS) {
      const pi = isRetryableAssistantError({ stopReason: "error", errorMessage } as never);
      expect([errorMessage, isRetryableErrorMessage(errorMessage)]).toEqual([errorMessage, pi]);
    }
  });

  it("never retries quota or billing exhaustion, even alongside a transient-looking code", () => {
    expect(isRetryableErrorMessage("429 insufficient_quota")).toBe(false);
  });

  it("treats a missing message as not retryable", () => {
    expect(isRetryableErrorMessage(undefined)).toBe(false);
  });
});

describe("backoff", () => {
  it("doubles from the base and caps at the ceiling, like pi-ai", () => {
    expect([1, 2, 3, 4, 5, 6].map((n) => retryDelayMs(DEFAULT_RETRY, n))).toEqual([500, 1000, 2000, 4000, 8000, 10_000]);
    for (const n of [1, 3, 9]) expect(retryDelayMs(DEFAULT_RETRY, n)).toBe(piRetryDelayMs(DEFAULT_RETRY, n));
  });

  it("jitters within ±10%", () => {
    expect(withJitter(1000, () => 0)).toBe(900);
    expect(withJitter(1000, () => 1)).toBe(1100);
    expect(withJitter(1000, () => 0.5)).toBe(1000);
  });

  it("a sleep ends early on abort", async () => {
    const ac = new AbortController();
    const started = Date.now();
    const p = abortableSleep(5000, ac.signal);
    ac.abort();
    await p;
    expect(Date.now() - started).toBeLessThan(1000);
    await abortableSleep(5000, ac.signal);
  });
});
