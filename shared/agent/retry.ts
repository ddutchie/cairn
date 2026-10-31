/**
 * Retry policy for a failed model request, shared by the desktop engine loop and the mobile chat loop
 * so both treat the same errors as transient and back off the same way. Pure TypeScript: no Node, no
 * provider SDK, so it runs under Hermes too.
 *
 * Classification is by error text because that is all a provider failure reliably carries across
 * transports. The patterns mirror `@earendil-works/pi-ai`'s `isRetryableAssistantError`
 * (shared/agent/retry.test.ts keeps the two in step).
 */

export interface RetryPolicy {
  enabled: boolean;
  /** Retries after the first attempt. */
  maxRetries: number;
  baseDelayMs: number;
  /** Ceiling for the doubled delay. */
  maxAgentDelayMs?: number;
}

/** 5 retries, 500 ms doubling, capped at 10 s. */
export const DEFAULT_RETRY: RetryPolicy = { enabled: true, maxRetries: 5, baseDelayMs: 500, maxAgentDelayMs: 10_000 };

const DEFAULT_MAX_DELAY_MS = 60_000;

/** Account or billing limits are deterministic: retrying only burns time. */
const NON_RETRYABLE = new RegExp([
  "GoUsageLimitError", "FreeUsageLimitError", "Monthly usage limit reached", "available balance",
  "insufficient_quota", "out of budget", "quota exceeded", "billing",
].join("|"), "i");

const RETRYABLE = new RegExp([
  "overloaded", "currently experiencing high demand", "rate.?limit", "too many requests",
  "429", "500", "502", "503", "504", "520", "524",
  "service.?unavailable", "server.?error", "internal.?error",
  "provider.?returned.?error", "exceeded request buffer limit while retrying upstream",
  "network.?error", "connection.?error", "connection.?refused", "connection.?lost", "other side closed",
  "fetch failed", "getaddrinfo", "ENOTFOUND", "EAI_AGAIN", "upstream.?connect", "reset before headers",
  "socket hang up", "socket connection was closed", "timed? out", "timeout", "terminated",
  "websocket.?closed", "websocket.?error",
  "ended without", "stream ended before message_stop", "stream ended before a terminal response event", "http2 request did not get a response",
  "retry delay", "you can retry your request", "try your request again", "please retry your request",
  "ResourceExhausted",
].join("|"), "i");

/** Whether a failure message looks transient (provider load, rate limit, dropped connection). */
export function isRetryableErrorMessage(message: string | undefined): boolean {
  if (!message) return false;
  return !NON_RETRYABLE.test(message) && RETRYABLE.test(message);
}

/** Delay before retry number `attempt` (1-based): base × 2^(attempt-1), capped. */
export function retryDelayMs(policy: RetryPolicy, attempt: number): number {
  const delay = policy.baseDelayMs * 2 ** Math.max(0, attempt - 1);
  const safe = Number.isSafeInteger(delay) ? delay : Number.MAX_SAFE_INTEGER;
  return Math.min(safe, policy.maxAgentDelayMs ?? DEFAULT_MAX_DELAY_MS);
}

/** ±10% so many clients hitting one overloaded provider do not retry in lockstep. */
export function withJitter(ms: number, random: () => number = Math.random): number {
  return Math.round(ms * (1 + (random() * 2 - 1) * 0.1));
}

/** Resolves after `ms`, or immediately when `signal` aborts. */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() { clearTimeout(timer); signal?.removeEventListener("abort", done); resolve(); }
    signal?.addEventListener("abort", done, { once: true });
  });
}
