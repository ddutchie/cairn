/**
 * Cairn — LLM usage recorder.
 *
 * Module-level singleton that writes one `llm_usage` row per LLM request at
 * every capture point in the main process (chat tool loop, pi agent loop,
 * subagents, automations, one-shot AI features). Mirrors the `config-cache`
 * pattern: the DB handle is set once at IPC registration and swapped when the
 * workspace changes; before then (or in tests / the MCP runtime) calls no-op so
 * recording can never break a chat/agent turn.
 */

import type Database from "better-sqlite3";
import { insertLlmUsage, type LlmUsageRecord, type UsageSource } from "../db/usage-queries";
import { endpointLogoSlug } from "../../shared/models/model-catalog";
import { getCachedConfig } from "./config-cache";
import { estimateCostUsd } from "./model-pricing";

let activeDb: Database.Database | null = null;

/** Point the recorder at the current app DB. Call with the DbContext's db. */
export function initUsageRecorder(db: Database.Database | null): void {
  activeDb = db;
}

// ── Provider name resolution ─────────────────────────────────────────────────
// The `provider` field in the saved config is a stale generic slug — it defaults
// to "openai" and is never updated when the user switches to a different saved
// provider (mirrorProvider only copies baseUrl/model/apiKey). The actual
// provider is only identifiable from the endpoint's baseUrl, so we resolve a
// display name from the hostname here, for every capture site uniformly.

/** Hostname → display name for well-known direct providers. */
const HOST_PROVIDER_NAMES: Record<string, string> = {
  "api.openai.com": "OpenAI",
  "openai.azure.com": "Azure OpenAI",
  "api.anthropic.com": "Anthropic",
  "generativelanguage.googleapis.com": "Google",
  "aiplatform.googleapis.com": "Google",
  "api.deepseek.com": "DeepSeek",
  "openrouter.ai": "OpenRouter",
  "api.together.ai": "Together AI",
  "api.together.xyz": "Together AI",
  "api.groq.com": "Groq",
  "api.fireworks.ai": "Fireworks",
  "api.x.ai": "xAI",
  "api.mistral.ai": "Mistral",
  "api.cohere.ai": "Cohere",
  "api.cohere.com": "Cohere",
  "integrate.api.nvidia.com": "NVIDIA",
  "api.neuralwatt.com": "NeuralWatt",
  "api.perplexity.ai": "Perplexity",
  "api.cerebras.ai": "Cerebras",
  "api.moonshot.ai": "Moonshot",
  "api.moonshot.cn": "Moonshot",
  "api.z.ai": "ZAI",
  "open.bigmodel.cn": "Zhipu AI",
  "api.ant-ling.com": "Ant Ling",
  "api.cloudflare.com": "Cloudflare",
  "gateway.ai.cloudflare.com": "Cloudflare",
  "chutes.ai": "Chutes",
};

function hostOf(baseUrl: string): string | null {
  try {
    return new URL(baseUrl).hostname.toLowerCase();
  } catch {
    // Bare host like "api.deepseek.com" — new URL needs a scheme.
    const m = baseUrl.match(/^([a-z0-9.-]+)(?:\/|$)/i);
    return (m?.[1] ?? "").toLowerCase() || null;
  }
}

function isLocalHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (h === "localhost" || h === "::1") return true;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) {
    const [a, b, c] = h.split(".").map(Number);
    if (a === 127 || a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    return a === 0 && b === 0 && c === 0;
  }
  return false;
}

/** Slug → display name for common provider slugs (community/manual installs). */
const SLUG_PROVIDER_NAMES: Record<string, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  openrouter: "OpenRouter",
  deepseek: "DeepSeek",
  together: "Together AI",
  "together-ai": "Together AI",
  groq: "Groq",
  xai: "xAI",
  mistral: "Mistral",
  mistralai: "Mistral",
  cohere: "Cohere",
  nvidia: "NVIDIA",
  neuralwatt: "NeuralWatt",
  perplexity: "Perplexity",
  google: "Google",
  moonshot: "Moonshot",
  cerebras: "Cerebras",
  zhipu: "Zhipu AI",
  bigmodel: "Zhipu AI",
  cloudflare: "Cloudflare",
  chutes: "Chutes",
  "fireworks-ai": "Fireworks",
  fireworks: "Fireworks",
};

function humanizeSlug(slug: string): string {
  return SLUG_PROVIDER_NAMES[slug] ?? slug.charAt(0).toUpperCase() + slug.slice(1);
}

function normalizeBase(s: string): string {
  return (s || "").trim().replace(/\/+$/, "").replace(/\/v1$/i, "");
}

/**
 * The user's own saved-provider NAME for this endpoint (from the cached
 * aiConfig.savedProviders list) — the most accurate label, since a saved
 * provider carries the name the user gave it. Falls back to baseUrl heuristics.
 */
function savedProviderNameFor(baseUrl?: string): string | undefined {
  if (!baseUrl) return undefined;
  const list = getCachedConfig().aiConfig?.savedProviders ?? [];
  if (list.length === 0) return undefined;
  const norm = normalizeBase(baseUrl);
  const match = list.find((p) => p.baseUrl && normalizeBase(p.baseUrl) === norm);
  return match?.name;
}

/**
 * Resolve a displayable provider name for a usage row. Prefers a well-known
 * hostname match on the base URL, then a meaningful provider slug, then the
 * hostname itself (so unknown gateways never read as "OpenAI"). Local endpoints
 * (localhost / 127.x / LAN ranges) always resolve to "Local".
 */
export function resolveProviderName(baseUrl?: string, providerSlug?: string): string | undefined {
  if (baseUrl) {
    const host = hostOf(baseUrl);
    if (host) {
      const known = HOST_PROVIDER_NAMES[host];
      if (known) return known;
      if (isLocalHost(host)) return "Local";
      // A meaningful (non-generic, non-local) slug beats a bare hostname for
      // unknown gateways — e.g. a community provider whose slug is "openrouter".
      if (providerSlug && providerSlug !== "openai" && providerSlug !== "localllm") {
        return humanizeSlug(providerSlug);
      }
      const slug = endpointLogoSlug(baseUrl);
      if (slug && slug !== "openai") return humanizeSlug(slug);
      return host;
    }
  }
  if (providerSlug) {
    if (providerSlug === "localllm") return "Local";
    if (providerSlug !== "openai") return humanizeSlug(providerSlug);
  }
  return "OpenAI";
}

/**
 * Normalise provider-reported cost from the various shapes seen across
 * OpenAI-compatible endpoints. Accepts a top-level `cost` on the chunk
 * (number, or `{ request_cost_usd }`) and `usage.cost`. Returns undefined
 * when the provider reported none — the caller then shows no cost for the row.
 */
export function extractCost(chunkCost?: unknown, raw?: unknown): number | undefined {
  const clean = (v: unknown): number | undefined => {
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) return v;
    if (typeof v === "object" && v !== null) {
      const rc = (v as { request_cost_usd?: unknown }).request_cost_usd;
      if (typeof rc === "number" && Number.isFinite(rc) && rc >= 0) return rc;
    }
    return undefined;
  };
  if (chunkCost != null) {
    const c = clean(chunkCost);
    if (c != null) return c;
  }
  if (raw != null) {
    const rawCost = (raw as { cost?: unknown }).cost;
    if (rawCost != null) {
      const c = clean(rawCost);
      if (c != null) return c;
    }
  }
  return undefined;
}

export interface RecordUsageArgs {
  source: UsageSource;
  sessionId?: string;
  projectId?: string;
  workspaceId?: string;
  provider?: string;
  model: string;
  baseUrl?: string;
  promptTokens?: number;
  completionTokens?: number;
  reasoningTokens?: number;
  costUsd?: number;
  /** True when the caller already knows the cost is a models.dev estimate. */
  costEstimated?: boolean;
  finishReason?: string;
}

/**
 * Write one usage row. Never throws — a recording failure must not disturb the
 * chat/agent loop it is hooked into.
 */
export function recordLlmUsage(entry: RecordUsageArgs): void {
  if (!activeDb) return;
  try {
    // The config's provider slug is a stale generic ("openai") — prefer the
    // user's saved-provider name for the endpoint, else resolve from the host.
    const provider =
      savedProviderNameFor(entry.baseUrl) ??
      resolveProviderName(entry.baseUrl, entry.provider);

    // When the provider doesn't report cost, estimate it from models.dev
    // per-1M pricing (flagged so the UI can mark it as an estimate).
    let costUsd = entry.costUsd;
    let costEstimated = entry.costEstimated ?? false;
    if (costUsd == null) {
      const estimate = estimateCostUsd(entry.model, entry.promptTokens ?? 0, entry.completionTokens ?? 0);
      if (estimate != null) {
        costUsd = estimate;
        costEstimated = true;
      }
    }

    const record: LlmUsageRecord = {
      id: "",
      createdAt: Date.now(),
      ...entry,
      provider,
      costUsd,
      costEstimated,
    };
    insertLlmUsage(activeDb, record);
  } catch (err) {
    console.error("[usage] failed to record LLM usage:", err);
  }
}
