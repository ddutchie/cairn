/**
 * Cairn — models.dev pricing cache (main process).
 *
 * The renderer owns the models.dev catalog (fetched once per run, cached in
 * localStorage). It pushes a compact `modelId → pricing` map (USD per 1M
 * tokens) over IPC once the catalog loads; this module holds it and lets the
 * usage recorder estimate cost for providers that don't report it.
 */

export interface ModelPrice {
  input: number | null;
  output: number | null;
  /** USD per 1M prompt-cache-read tokens (models.dev cost.cache_read). */
  cacheRead?: number | null;
  /** USD per 1M prompt-cache-write tokens (models.dev cost.cache_write). */
  cacheWrite?: number | null;
}

let pricing: Record<string, ModelPrice> | null = null;

export function setModelPricing(map: Record<string, ModelPrice> | null): void {
  pricing = map && Object.keys(map).length > 0 ? map : null;
}

/** USD per 1M tokens for a model id, or null when unknown. */
export function pricePerMillion(model: string): ModelPrice | null {
  if (!pricing || !model) return null;
  const resolve = (id: string): ModelPrice | null => {
    const exact = pricing![id];
    if (exact) return exact;
    // Fuzzy match for gateway ids that embed the catalog id as a whole token —
    // e.g. "playground-gpt-4o" → "gpt-4o". A match only counts when a separator
    // (-, /, :, .) precedes it, so "chatgpt-4o" can never hit "gpt-4o" pricing.
    const base = id.toLowerCase();
    const boundary = (s: string, start: number) => start === 0 || /[-/:._]/.test(s[start - 1] ?? "");
    for (const [catId, price] of Object.entries(pricing!)) {
      const nid = catId.toLowerCase();
      if (nid && base.endsWith(nid) && boundary(base, base.length - nid.length)) return price;
      if (nid.endsWith(base) && boundary(nid, nid.length - base.length)) return price;
    }
    return null;
  };
  const priced = resolve(model);
  if (priced) return priced;
  // Retry with trailing qualifier segments stripped — handles region / date /
  // reasoning suffixes (deepseek-v4-flash-gcp, deepseek-v4-flash-0731-gcp,
  // deepseek-v4-flash:thinking) that no catalog id carries verbatim.
  let candidate = model;
  for (let i = 0; i < 3; i++) {
    const next = candidate.replace(/[-:.][a-z0-9]+$/i, "");
    if (next === candidate || !next) break;
    candidate = next;
    const hit = resolve(candidate);
    if (hit) return hit;
  }
  return null;
}

/**
 * Estimate the USD cost of a request from models.dev per-1M pricing.
 * Returns undefined when pricing is unknown for the model or there are no tokens.
 *
 * Cache-aware: when the provider reports cache-read/creation token counts, the
 * cached portions are priced at the model's cache rates (falling back to the
 * full input rate when the catalog doesn't price them) instead of the full
 * input rate — mirroring how providers actually bill prompt caching. The
 * provider's own `usage.cost` (when present) already accounts for this.
 */
export function estimateCostUsd(
  model: string,
  promptTokens: number,
  completionTokens: number,
  cacheReadTokens = 0,
  cacheCreationTokens = 0,
): number | undefined {
  const price = pricePerMillion(model);
  if (!price) return undefined;
  const input = price.input ?? 0;
  const output = price.output ?? 0;
  const cacheReadPrice = price.cacheRead ?? input;
  const cacheWritePrice = price.cacheWrite ?? input;
  if (input <= 0 && output <= 0) return undefined;
  if (promptTokens <= 0 && completionTokens <= 0) return undefined;

  const read = Math.max(0, Math.min(cacheReadTokens, promptTokens));
  const write = Math.max(0, Math.min(cacheCreationTokens, promptTokens - read));
  const fresh = Math.max(0, promptTokens - read - write);

  const promptCost =
    (fresh / 1e6) * input +
    (read / 1e6) * cacheReadPrice +
    (write / 1e6) * cacheWritePrice;
  return promptCost + (completionTokens / 1e6) * output;
}
