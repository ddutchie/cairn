/**
 * Prompt-side context size of one model request, from a dsh `TokenUsage`.
 *
 * dsh ≥0.2 reports DISJOINT counts: `inputTokens` is the uncached input only,
 * cached input arrives separately as `cacheReadTokens` / `cacheWriteTokens`
 * (see `TokenUsage` in `@deepseek-ai/dsh-llm`). With prompt caching on, a
 * mid-session request reports a tiny `inputTokens` (just the new delta), so
 * reading it as "context size" collapsed the Context Ring to the system-prompt
 * slice. This mirrors dsh token-meter's own `pressureFrom`.
 *
 * A usage already normalised by Cairn (carries `promptTokens`) is taken as-is.
 */
export function contextPressureTokens(usage: unknown): number {
  if (typeof usage !== "object" || usage === null) return 0;
  const u = usage as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
  if (typeof u.promptTokens === "number") return n(u.promptTokens);
  return n(u.inputTokens) + n(u.cacheReadTokens) + n(u.cacheWriteTokens ?? u.cacheCreationTokens);
}
