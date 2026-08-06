/**
 * Cairn — models.dev pricing cache (main process).
 *
 * The renderer owns the models.dev catalog (fetched once per run, cached in
 * localStorage). It pushes a compact `modelId → { input, output }` pricing map
 * (USD per 1M tokens) over IPC once the catalog loads; this module holds it and
 * lets the usage recorder estimate cost for providers that don't report it.
 */

let pricing: Record<string, { input: number | null; output: number | null }> | null = null;

export function setModelPricing(map: Record<string, { input: number | null; output: number | null }> | null): void {
  pricing = map && Object.keys(map).length > 0 ? map : null;
}

/** USD per 1M tokens for a model id, or null when unknown. */
export function pricePerMillion(model: string): { input: number | null; output: number | null } | null {
  if (!pricing || !model) return null;
  const exact = pricing[model];
  if (exact) return exact;
  // Fuzzy match for gateway ids that embed the catalog id as a whole token —
  // e.g. "playground-gpt-4o" → "gpt-4o". A match only counts when a separator
  // (-, /, :, .) precedes it, so "chatgpt-4o" can never hit "gpt-4o" pricing.
  const base = model.toLowerCase();
  const boundary = (s: string, start: number) => start === 0 || /[-/:._]/.test(s[start - 1] ?? "");
  for (const [id, price] of Object.entries(pricing)) {
    const nid = id.toLowerCase();
    if (nid && base.endsWith(nid) && boundary(base, base.length - nid.length)) return price;
    if (nid.endsWith(base) && boundary(nid, nid.length - base.length)) return price;
  }
  return null;
}

/**
 * Estimate the USD cost of a request from models.dev per-1M pricing.
 * Returns undefined when pricing is unknown for the model or there are no tokens.
 */
export function estimateCostUsd(model: string, promptTokens: number, completionTokens: number): number | undefined {
  const price = pricePerMillion(model);
  if (!price) return undefined;
  const input = price.input ?? 0;
  const output = price.output ?? 0;
  if (input <= 0 && output <= 0) return undefined;
  if (promptTokens <= 0 && completionTokens <= 0) return undefined;
  return (promptTokens / 1e6) * input + (completionTokens / 1e6) * output;
}
