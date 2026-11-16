/**
 * Shared number/byte/duration formatters — pure functions, no platform deps.
 *
 * Each function pins one exact rendering already shipped in the app (see
 * number.test.ts). Call sites must keep the same options so no visible string
 * changes: `k` vs `K` via `upper`, binary vs SI bytes via separate functions.
 */

function trim0(s: string): string {
  return s.replace(/\.0$/, "");
}

/**
 * Compact thousands: 1000→"1k", 1500→"1.5k", 999→"999".
 * Pass `upper: true` for the "1K" variant. Matches OutputBudgetWarning,
 * McpToolList (lower) and ContextRing (upper).
 */
export function formatCompact(n: number, opts?: { upper?: boolean }): string {
  const suffix = opts?.upper ? "K" : "k";
  if (n >= 1000) return trim0((n / 1000).toFixed(1)) + suffix;
  return String(n);
}

/**
 * Compact with million tier, rounded + clamped at zero:
 * 1234000→"1.2M", 48000→"48K", 999→"999", -5→"0".
 * Matches the Usage view fmtCompact (the only copy with an M tier).
 */
export function formatCompactWithMillion(n: number): string {
  const v = Math.max(0, Math.round(n));
  if (v >= 1e6) return trim0((v / 1e6).toFixed(1)) + "M";
  if (v >= 1e3) return trim0((v / 1e3).toFixed(1)) + "K";
  return String(v);
}

/**
 * Binary megabytes, zero decimals: 104857600→"100 MB".
 * Matches EmbeddingsSettings fmtSize.
 */
export function formatMegabytes(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(0) + " MB";
}

/**
 * Decimal SI with mixed rounding: 1.5e9→"1.5 GB", 5e6→"5 MB", 1500→"2 KB".
 * Matches DataSettings formatBytes (no B tier — sub-KB rounds to KB).
 */
export function formatBytesSI(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${Math.round(n / 1e6)} MB`;
  return `${Math.round(n / 1e3)} KB`;
}

/**
 * Binary compact, no space: 500→"500B", 2048→"2.0KB", 5242880→"5.0MB".
 * Matches the truncation hint in automation-script.
 */
export function formatBytesBinary(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/**
 * Duration milliseconds: 45000→"45s", 125000→"2m 5s", 3780000→"1h 3m".
 * Core of AgentJobsDock formatElapsed (which also handles the startedAt /
 * finishedAt wrapper and the live clock).
 */
export function formatDurationMs(ms: number): string {
  const clamped = Math.max(0, ms);
  const s = Math.floor(clamped / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
