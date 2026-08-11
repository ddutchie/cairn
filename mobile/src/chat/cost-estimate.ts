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

import { getModelInfo } from "./models-dev";

export function estimateChatCostUsd(
  model: string,
  promptTokens: number,
  completionTokens: number,
  cacheReadTokens = 0,
  cacheCreationTokens = 0,
): number | undefined {
  if (!model) return undefined;
  const info = getModelInfo(model);
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
