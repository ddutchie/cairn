/**
 * Cache-hit colouring for the prompt-cache rows (ContextRing popover, Usage view).
 *
 * Higher cache-read percentages are better — the provider is serving more of the
 * prompt from cache instead of re-processing it. The scale is monotonic:
 *
 *   ≥ 50%  → green  (var(--success))     — the prompt is largely cache-served
 *   25–50% → accent (var(--accent))      — meaningful cache utilisation
 *   > 0%   → amber  (var(--warning))     — caching has started, still early
 *   0%     → grey   (var(--text-tertiary)) — no cached tokens this turn
 */
export function cacheHitColor(readPct: number): string {
  if (readPct >= 0.5) return "var(--success)";
  if (readPct >= 0.25) return "var(--accent)";
  if (readPct > 0) return "var(--warning)";
  return "var(--text-tertiary)";
}
