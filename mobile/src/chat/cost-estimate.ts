/**
 * Client-side cost estimation — the mobile analogue of desktop's
 * estimateCostUsd (electron/lib/model-pricing.ts). When a provider reports no
 * cost, we estimate it from the models.dev per-1M pricing for the model,
 * cache-aware (cached input is priced at the cache-read/write rates, not full
 * input), and flag the record as estimated.
 *
 * Returns undefined when the model isn't in the catalog or has no pricing, so
 * an un-known model simply shows no cost (same as desktop).
 */

import { getModelInfo, getModelCatalogMap } from "./models-dev";
import type { ModelInfo } from "@cairn/shared/models/model-catalog";

/**
 * Resolve pricing info for a model id. Tries the exact/normalized catalog
 * lookup first, then falls back to the same fuzzy match desktop's
 * pricePerMillion uses — so a gateway/proxy id that embeds the catalog id as a
 * whole token (e.g. "playground-gpt-4o" → "gpt-4o", or "opencode-go/
 * deepseek-v4-flash") still gets priced. A match only counts when a separator
 * precedes the embedded id, so "chatgpt-4o" can never hit "gpt-4o" pricing.
 *
 * Entries with NO pricing (models.dev lists some bare ids and `:free` variants
 * with an empty/zero cost) are skipped, so the fuzzy pass lands on a PRICED
 * variant (e.g. `deepseek-v4-flash` → `deepseek/deepseek-v4-flash`) instead of
 * returning nothing.
 */
function hasPricing(info: ModelInfo): boolean {
  return (info.input ?? 0) > 0 || (info.output ?? 0) > 0;
}

function pricingInfoFor(model: string): ModelInfo | null {
  const direct = getModelInfo(model);
  if (direct && hasPricing(direct)) return direct;
  const map = getModelCatalogMap();
  if (!map) return null;
  const base = model.toLowerCase();
  const boundary = (s: string, start: number) => start === 0 || /[-/:._]/.test(s[start - 1] ?? "");
  for (const [id, info] of Object.entries(map)) {
    if (!hasPricing(info)) continue;
    const nid = id.toLowerCase();
    if (nid && base.endsWith(nid) && boundary(base, base.length - nid.length)) return info;
    if (nid.endsWith(base) && boundary(nid, nid.length - base.length)) return info;
  }
  return null;
}

export function estimateChatCostUsd(
  model: string,
  promptTokens: number,
  completionTokens: number,
  cacheReadTokens = 0,
  cacheCreationTokens = 0,
): number | undefined {
  if (!model) return undefined;
  const info = pricingInfoFor(model);
  if (!info) return undefined;
  const input = info.input ?? 0;
  const output = info.output ?? 0;
  if (input <= 0 && output <= 0) return undefined;
  if (promptTokens <= 0 && completionTokens <= 0) return undefined;

  const cacheReadPrice = info.cacheRead ?? input;
  const cacheWritePrice = info.cacheWrite ?? input;
  const read = Math.max(0, Math.min(cacheReadTokens, promptTokens));
  const write = Math.max(0, Math.min(cacheCreationTokens, promptTokens - read));
  const fresh = Math.max(0, promptTokens - read - write);

  return (
    (fresh / 1e6) * input +
    (read / 1e6) * cacheReadPrice +
    (write / 1e6) * cacheWritePrice +
    (completionTokens / 1e6) * output
  );
}
