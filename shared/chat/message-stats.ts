/**
 * Shared formatters for per-message and per-session throughput/latency stats
 * (ported alongside the DSH session-stats projection). Kept pure + tiny so both
 * the chat and coding renderers, and the composer stats line, format identically.
 */

export interface MessageStatsLike {
  ttftMs?: number;
  tokensPerSecond?: number;
  outputTokens?: number;
}

/** "1.2s" / "840ms" — compact latency. Returns null for missing/invalid. */
export function formatLatency(ms: number | undefined): string | null {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return null;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
}

/** "62 tok/s" — throughput. Returns null for missing/invalid/zero. */
export function formatThroughput(tps: number | undefined): string | null {
  if (typeof tps !== "number" || !Number.isFinite(tps) || tps <= 0) return null;
  return `${tps >= 100 ? Math.round(tps) : tps.toFixed(1)} tok/s`;
}

/** "1.2K tok" / "840 tok" — output token count. Returns null for missing/invalid. */
export function formatOutputTokens(n: number | undefined): string | null {
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return null;
  const label = n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, "")}K` : `${n}`;
  return `${label} tok`;
}

/**
 * Build the compact segments for a message/turn stats line, in display order:
 * TTFT · tok/s · output tokens. Only includes segments that are present, so a
 * message with only timing (no usage) shows just TTFT — never a zero/NaN.
 * Returns [] when nothing is derivable (caller renders no line).
 */
export function messageStatsSegments(stats: MessageStatsLike | undefined): string[] {
  if (!stats) return [];
  const out: string[] = [];
  const ttft = formatLatency(stats.ttftMs);
  if (ttft) out.push(`${ttft} to first token`);
  const tps = formatThroughput(stats.tokensPerSecond);
  if (tps) out.push(tps);
  const tok = formatOutputTokens(stats.outputTokens);
  if (tok) out.push(tok);
  return out;
}
