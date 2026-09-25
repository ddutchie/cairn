/**
 * Compaction pressure against the message budget, not the whole window.
 *
 * dsh-compaction-basic (0.1.5) scales `thresholdRatio` by the route's entire
 * `contextWindow`, but every request also reserves `maxTokens` of output from
 * that same window. With Cairn's defaults (128K window, 32K output) the gate
 * sat at ~102K prompt tokens while the provider already refused anything over
 * ~96K, so long chats hit "maximum context length" before auto-compaction ever
 * ran. Upstream fixed this in 0.1.7 ("gate pressure on the message budget");
 * until then we install a per-route `modelPolicies` override for the Cairn
 * provider whose ratio is scaled to `(contextWindow - maxTokens) / contextWindow`.
 */

import { symbols, type Context } from "@deepseek-ai/cordis";

/** Share of the message budget at which proactive compaction fires. */
export const COMPACTION_THRESHOLD_RATIO = 0.8;
/** dsh-compaction-basic's default retainRatio (must stay below the threshold). */
const DEFAULT_RETAIN_RATIO = 0.16;

export interface CompactionModelPolicy {
  provider: string;
  model: string;
  thresholdRatio: number;
  retainRatio?: number;
}

/**
 * Policy override for one route, or undefined when the window leaves no
 * message budget (the overflow-recovery path still applies then).
 */
export function compactionPolicyFor(provider: string, model: string, contextWindow: number, maxTokens: number): CompactionModelPolicy | undefined {
  if (!(contextWindow > 0) || !(maxTokens >= 0) || maxTokens >= contextWindow) return undefined;
  const thresholdRatio = Math.floor((COMPACTION_THRESHOLD_RATIO * (contextWindow - maxTokens) / contextWindow) * 1000) / 1000;
  if (!(thresholdRatio > 0)) return undefined;
  return {
    provider,
    model,
    thresholdRatio,
    // The engine rejects retainRatio >= thresholdRatio; only tiny budgets need this.
    ...(thresholdRatio <= DEFAULT_RETAIN_RATIO ? { retainRatio: thresholdRatio / 2 } : {}),
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
