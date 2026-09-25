/**
 * Compaction pressure against the message budget, not the whole window.
 *
 * dsh-compaction-basic 0.1.7 prices each routed request as
 *   threshold = min(contextWindow * thresholdRatio, messageBudget - headroomTokens)
 * where messageBudget = contextWindow - the request's reserved output tokens,
 * and headroomTokens (default 64K, also the summary's default maxTokens) is a
 * fixed reserve. That fits 1M-token routes but not Cairn's typical ones: with
 * the default 128K window / 32K output it would compact at ~32K tokens, and any
 * route whose message budget is under 64K gets no auto-compaction at all
 * (the engine logs a pressure-config warning once and skips it).
 *
 * So the active Cairn route gets a per-route `modelPolicies` override that
 * sizes the headroom to the budget: threshold = 80% of the message budget,
 * headroom (the summary's room) = the remaining 20%.
 */

import { symbols, type Context } from "@deepseek-ai/cordis";

/** Share of the message budget at which proactive compaction fires. */
export const COMPACTION_THRESHOLD_RATIO = 0.8;
/** dsh-compaction-basic's default summary cap when the route declares no output limit. */
const DEFAULT_SUMMARY_MAX_TOKENS = 65536;

export interface CompactionModelPolicy {
  provider: string;
  model: string;
  thresholdRatio: number;
  headroomTokens: number;
  maxTokens: number;
}

/**
 * Policy override for one route, or undefined when the window leaves no
 * message budget (the overflow-recovery path still applies then).
 */
export function compactionPolicyFor(provider: string, model: string, contextWindow: number, maxTokens: number): CompactionModelPolicy | undefined {
  if (!Number.isInteger(contextWindow) || contextWindow <= 0 || !(maxTokens >= 0) || maxTokens >= contextWindow) return undefined;
  const budget = contextWindow - maxTokens;
  const headroomTokens = budget - Math.floor(COMPACTION_THRESHOLD_RATIO * budget);
  if (headroomTokens <= 0 || headroomTokens >= budget) return undefined;
  return {
    provider,
    model,
    // The window-fraction cap is disabled; the budget-minus-headroom cap decides.
    thresholdRatio: 1,
    headroomTokens,
    // The summary must fit the headroom and the route's own output limit.
    maxTokens: Math.min(headroomTokens, maxTokens > 0 ? maxTokens : DEFAULT_SUMMARY_MAX_TOKENS),
  };
}

interface EngineWithConfig {
  config?: { modelPolicies?: readonly CompactionModelPolicy[] } & Record<string, unknown>;
}

/**
 * Replace the Cairn route's policy on the live compaction engine. The engine
 * re-resolves `this.config.modelPolicies` on every pressure check, so swapping
 * the (frozen) config object takes effect from the next step without a remount.
 */
export function applyCompactionBudget(ctx: Context, provider: string, model: string, contextWindow: number, maxTokens: number): void {
  const traced = (ctx as unknown as { compaction?: EngineWithConfig }).compaction;
  // Write on the raw engine, not Cordis' traceable proxy, so `this.config`
  // inside the engine's own methods sees the new object.
  const engine = ((traced as Record<symbol, unknown> | undefined)?.[symbols.original] ?? traced) as EngineWithConfig | undefined;
  const config = engine?.config;
  if (!engine || !config || !Array.isArray(config.modelPolicies)) return;
  const others = config.modelPolicies.filter((p) => p.provider !== provider);
  const policy = compactionPolicyFor(provider, model, contextWindow, maxTokens);
  engine.config = Object.freeze({ ...config, modelPolicies: Object.freeze(policy ? [...others, policy] : others) });
}
