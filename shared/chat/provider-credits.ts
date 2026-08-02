/**
 * Cairn — Provider credit/balance parsing (shared desktop + mobile).
 *
 * Pure, framework-free module: resolves a provider's `credits` descriptor from
 * the community providers.json manifest and parses a credit endpoint's response
 * per its declared `shape`. No I/O and no Electron / React Native imports — the
 * fetch layer lives with each caller:
 *   - Electron: electron/lib/provider-credits.ts re-exports this and hosts the
 *     global-fetch `probeCredits` probe for the `ai:fetchKeyInfo` IPC handler.
 *   - Mobile: mobile/src/chat/providers/openai.ts feeds expo/fetch responses
 *     into `parseCredits` directly.
 */

import type { ProviderCreditsSpec } from "./registry-schema";

/** Normalised key-info result shown to the user. */
export type CreditInfo = {
  remaining: number | null;
  usage: number | null;
  limit: number | null;
  isFreeTier: boolean | null;
  currency: "USD" | "CNY";
};

/** Shape of a manifest provider entry's `definition` as read by credit lookup. */
interface ManifestProviderDefinition {
  baseUrl: string;
  credits?: ProviderCreditsSpec;
}

/** Strip trailing slashes — the base-URL comparison used by `sameEndpoint`. */
function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/** Treat two endpoints as the same even when one omits the "/v1" segment. */
export function sameEndpoint(a: string, b: string): boolean {
  const x = stripTrailingSlash(a);
  const y = stripTrailingSlash(b);
  return x === y || `${x}/v1` === y || `${y}/v1` === x;
}

/**
 * Look up a provider's credit/balance descriptor by matching the given chat
 * endpoint against a manifest's providers. Returns null (→ default /v1/key
 * probe) when no provider matches or it exposes no balance API.
 */
export function resolveCreditSpec(
  baseUrl: string,
  providers: Array<{ definition?: ManifestProviderDefinition }>
): ProviderCreditsSpec | null {
  for (const p of providers) {
    const def = p.definition;
    const spec = def?.credits;
    if (def && spec && sameEndpoint(def.baseUrl, baseUrl)) return spec;
  }
  return null;
}

/** Parse a provider credit response per the manifest's declared shape. */
export function parseCredits(shape: string, json: unknown): CreditInfo | null {
  switch (shape) {
    case "deepseek":
      return parseDeepSeekCredits(json);
    case "openai-grants":
      return parseOpenAiGrantsCredits(json);
    case "neuralwatt":
      return parseNeuralwattCredits(json);
    case "openrouter":
    default:
      return parseOpenRouterCredits(json);
  }
}

/** OpenRouter: GET {base}/key → { data: { limit, limit_remaining, usage, is_free_tier } }. */
export function parseOpenRouterCredits(json: unknown): CreditInfo | null {
  const d = (json as { data?: Record<string, unknown> })?.data;
  if (!d || typeof d !== "object") return null;
  const usage = typeof d.usage === "number" ? d.usage : null;
  const limit = typeof d.limit === "number" ? d.limit : null;
  // Prefer the explicit remaining figure; else derive from limit - usage.
  const remaining =
    typeof d.limit_remaining === "number"
      ? d.limit_remaining
      : limit != null && usage != null
        ? limit - usage
        : null;
  // Nothing usable to show.
  if (remaining == null && usage == null && limit == null) return null;
  return {
    remaining,
    usage,
    limit,
    isFreeTier: typeof d.is_free_tier === "boolean" ? d.is_free_tier : null,
    currency: "USD",
  };
}

/**
 * DeepSeek: GET https://api.deepseek.com/user/balance →
 * { is_available, balance_infos: [{ currency, total_balance, granted_balance,
 * topped_up_balance }] }. Amounts are decimal strings; prefer the USD row.
 */
export function parseDeepSeekCredits(json: unknown): CreditInfo | null {
  const body = json as {
    is_available?: boolean;
    balance_infos?: Array<{
      currency?: string;
      total_balance?: string;
      granted_balance?: string;
      topped_up_balance?: string;
    }>;
  };
  const infos = Array.isArray(body?.balance_infos) ? body.balance_infos : [];
  if (infos.length === 0) return null;
  const row = infos.find((i) => i?.currency === "USD") ?? infos[0];
  const raw = row?.total_balance;
  const remaining = typeof raw === "string" ? Number.parseFloat(raw) : NaN;
  if (Number.isNaN(remaining)) return null;
  const currency = row?.currency === "CNY" ? ("CNY" as const) : ("USD" as const);
  return {
    remaining,
    usage: null,
    limit: null,
    isFreeTier: body.is_available == null ? null : body.is_available === false,
    currency,
  };
}

/**
 * OpenAI (legacy, undocumented — may break): GET {base}/v1/dashboard/billing/
 * credit_grants → { total_granted, total_used, total_available, grants[] }.
 */
export function parseOpenAiGrantsCredits(json: unknown): CreditInfo | null {
  const body = json as { total_available?: number | string };
  const raw = body?.total_available;
  const remaining = typeof raw === "number" ? raw : typeof raw === "string" ? Number.parseFloat(raw) : NaN;
  if (Number.isNaN(remaining)) return null;
  return { remaining, usage: null, limit: null, isFreeTier: null, currency: "USD" };
}

/**
 * Neuralwatt: GET https://api.neuralwatt.com/v1/quota →
 * { balance: { credits_remaining_usd, total_credits_usd, credits_used_usd },
 *   accounting_method, ... }. Credits are energy units, USD-valued.
 */
export function parseNeuralwattCredits(json: unknown): CreditInfo | null {
  const b = (json as { balance?: Record<string, unknown> })?.balance;
  if (!b || typeof b !== "object") return null;
  const readNum = (v: unknown): number | null =>
    typeof v === "number" ? v : typeof v === "string" ? Number.parseFloat(v) : NaN;
  const remaining = readNum(b.credits_remaining_usd);
  const limit = readNum(b.total_credits_usd);
  const usage = readNum(b.credits_used_usd);
  const clean = (n: number | null): number | null => (n != null && Number.isNaN(n) ? null : n);
  if (clean(remaining) == null && clean(limit) == null && clean(usage) == null) return null;
  return {
    remaining: clean(remaining),
    usage: clean(usage),
    limit: clean(limit),
    isFreeTier: null,
    currency: "USD",
  };
}

// ── Display formatting ─────────────────────────────────────────────────────────

/** USD cost: 0.00219 → "$0.0022"; tiny costs (e.g. $0.000001) keep a significant digit instead of collapsing to "$0". */
export function formatUsd(cost: number): string {
  if (cost === 0) return "$0";
  if (cost >= 0.00001) return `$${cost.toFixed(5).replace(/\.?0+$/, "")}`;
  return `$${parseFloat(cost.toPrecision(2)).toString()}`;
}

/** "5.42 of 45.5" / "5.42" / "Free tier" / "Used 40.08" for a balance row. */
export function formatBalance(info: CreditInfo): string {
  const sym = info.currency === "CNY" ? "¥" : "$";
  const fmt = (n: number) => {
    const abs = Math.abs(n);
    const digits = abs > 0 && abs < 1 ? 4 : 2;
    const body = abs.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: digits });
    return n < 0 ? `-${sym}${body}` : `${sym}${body}`;
  };
  if (info.remaining != null) {
    return info.limit != null ? `${fmt(info.remaining)} of ${fmt(info.limit)}` : fmt(info.remaining);
  }
  if (info.isFreeTier === true) return "Free tier";
  if (info.usage != null && info.usage > 0) return `Used ${fmt(info.usage)}`;
  return "Free tier";
}
