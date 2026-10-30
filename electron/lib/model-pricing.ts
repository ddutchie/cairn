/**
 * Cairn — models.dev pricing + temperature-capability cache (main process).
 *
 * The renderer owns the models.dev catalog (fetched once per run, cached in
 * localStorage). It pushes a compact `modelId → pricing` map (USD per 1M
 * tokens) and a `modelId → temperature-supported` map over IPC once the
 * catalog loads; this module holds them and lets the usage recorder estimate
 * cost and the request builders honour each model's temperature capability.
 */

export type { ModelPrice } from "../../shared/types/app";
import type { ModelPrice } from "../../shared/types/app";
import { protocolForEndpointModel, type WireProtocol } from "../../shared/models/model-catalog";

let pricing: Record<string, ModelPrice> | null = null;

/** Model ids that models.dev marks `temperature: false` (never send temperature). */
let noTemperature: Set<string> | null = null;

export function setModelPricing(map: Record<string, ModelPrice> | null): void {
  pricing = map && Object.keys(map).length > 0 ? map : null;
}

/** Record which model ids declare they do NOT support temperature control. */
export function setNoTemperatureModels(ids: string[] | null): void {
  noTemperature = ids && ids.length > 0 ? new Set(ids) : null;
}

/**
 * Whether a model accepts temperature control. Unknown models are permissive
 * (true) — only models models.dev explicitly marks `temperature: false` are
 * rejected, mirroring how the renderer's attachment gates stay permissive for
 * models the catalog can't resolve.
 */
export function supportsTemperature(model: string): boolean {
  if (!noTemperature || !model) return true;
  if (noTemperature.has(model)) return false;
  // Fuzzy match for gateway ids that embed the catalog id as a whole token,
  // mirroring pricePerMillion's resolution.
  const base = model.toLowerCase();
  const boundary = (s: string, start: number) => start === 0 || /[-/:._]/.test(s[start - 1] ?? "");
  for (const catId of noTemperature) {
    const nid = catId.toLowerCase();
    if (nid && base.endsWith(nid) && boundary(base, base.length - nid.length)) return false;
    if (nid.endsWith(base) && boundary(nid, nid.length - base.length)) return false;
  }
  // Retry with trailing qualifier segments stripped (region / date / reasoning
  // suffixes) — same fallback as pricePerMillion.
  let candidate = model;
  for (let i = 0; i < 3; i++) {
    const next = candidate.replace(/[-:.][a-z0-9]+$/i, "");
    if (next === candidate || !next) break;
    candidate = next;
    if (noTemperature.has(candidate)) return false;
  }
  return true;
}

/**
 * The temperature to actually SEND for a model: `undefined` (omit → vendor
 * default) for models that declare they don't support it, otherwise the
 * requested value as-is. Unknown models are permissive.
 */
export function resolveTemperatureForModel(model: string, requested: number | undefined): number | undefined {
  return supportsTemperature(model) ? requested : undefined;
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

// ── Per-model wire protocol (OpenCode) ───────────────────────────────────────
// OpenCode serves each model over exactly one protocol; models.dev records the
// exceptions to Chat Completions. The renderer parses them from its catalog and
// pushes the map here so every main-side request path can honour it.

let endpointProtocols: Record<string, WireProtocol> | null = null;

export function setEndpointProtocols(map: Record<string, WireProtocol> | null): void {
  endpointProtocols = map && Object.keys(map).length > 0 ? map : null;
}

/** Protocols a caller may configure (the provider apiMode). */
type ConfiguredApi = "openai-completions" | "openai-responses" | "anthropic-messages";
/** Protocols the patched harness can mount (engine-llm-pi-ai + Cairn's Gemini patch). */
export type PiApi = ConfiguredApi | "google-generative-ai";

/**
 * The pi-ai api to mount for `model` at `baseUrl`: the endpoint's own protocol
 * when it dictates one (OpenCode), else the provider's configured `api`.
 * Deterministic per model, so a resumed session replays under the same api.
 * Gemini-only models mount Google's generateContent API, which the harness
 * serves through patches/@deepseek-ai+engine-llm-pi-ai.
 */
export function wireApiFor(baseUrl: string, model: string, api: ConfiguredApi): PiApi {
  const protocol = protocolForEndpointModel(endpointProtocols, baseUrl, model);
  if (protocol === "responses") return "openai-responses";
  if (protocol === "anthropic-messages") return "anthropic-messages";
  if (protocol === "google") return "google-generative-ai";
  if (protocol === "completions") return "openai-completions";
  return api;
}

/**
 * The base URL to mount `api` on. OpenCode Go's `/zen/go/v1` gateway has no
 * Gemini route (404 for `models/<id>:streamGenerateContent`); its inference
 * host `/inference/go/v1` — the base models.dev lists for opencode-go — serves
 * every protocol, Gemini included. Zen's `/zen/v1` serves Gemini itself.
 */
export function wireBaseUrlFor(baseUrl: string, api: PiApi): string {
  if (api !== "google-generative-ai") return baseUrl;
  return baseUrl.replace(/^(https?:\/\/(?:[^/]*\.)?opencode\.ai)\/zen\/go(?=\/|$)/i, "$1/inference/go");
}
