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
  // Normalized/fuzzy match for gateway ids (e.g. "playground-claude-opus" →
  // "claude-opus-...") — try stripping a leading provider prefix and matching
  // on a model-name token.
  const base = model.toLowerCase();
  for (const [id, price] of Object.entries(pricing)) {
    if (id.toLowerCase().endsWith(base) || base.endsWith(id.toLowerCase())) return price;
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
