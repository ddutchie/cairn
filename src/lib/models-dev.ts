/**
 * models.dev model-catalog lookup (desktop).
 *
 * Fetches the public models.dev catalog (https://models.dev/api.json) and maps a
 * model id → model metadata (context window, per-1M-token input/output cost,
 * image-input support, tool-calling, owning provider logo). Consumers:
 *  - the chat context ring auto-sizes from `contextLimitForModel`
 *  - model pickers show per-model cost, provider logo and image/tool markers
 *
 * The catalog is ~3MB, so we fetch it at most once per app run (in-memory) and
 * persist the compact id→info map to localStorage so subsequent runs resolve
 * instantly and offline. Everything is best-effort: on any failure the caller
 * falls back to a default limit.
 *
 * Parsing / normalization / formatting live in shared/models/model-catalog.ts
 * (shared with mobile). This file is the desktop fetch + persistence + a tiny
 * subscribe API so React pickers re-render once the catalog arrives.
 *
 * Ported from the mobile implementation (mobile/src/chat/models-dev.ts), swapping
 * expo/fetch + SQLite app_settings for the browser fetch + localStorage.
 */

import { useSyncExternalStore } from "react";
import {
  logoProviderFor,
  lookupModelInfo,
  normalizeModelInfo,
  parseCanonicalCatalog,
  parseModelCatalog,
  providerLogoUrl,
  type ModelInfo,
  resolveMaxOutputTokens,
} from "../../shared/models/model-catalog";

const API_URL = "https://models.dev/api.json";
// v2: bumped when the parsed ModelInfo shape gains a field (maxOutput) so
// existing caches re-fetch immediately instead of waiting out the weekly TTL
// with the old field-poor entries.
const CACHE_KEY = "ai.modelInfo.cache.v2"; // JSON { [modelId]: ModelInfo }
const CACHE_AT_KEY = "ai.modelInfo.cachedAt.v2";
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // refresh weekly
// Canonical owner map (models.json): id → provider slug for logo resolution.
// Tiny (282 entries) and keyed by canonical "<provider>/<model>" ids, so it's
// cached separately with its own freshness window.
const CANONICAL_URL = "https://models.dev/models.json";
const CANONICAL_CACHE_KEY = "ai.canonical.cache"; // JSON { [canonicalId]: provider }
const CANONICAL_CACHE_AT_KEY = "ai.canonical.cachedAt";
// In-memory cache of fetched models.dev logo SVG strings (per provider slug):
// shared by ConnectorLogo so a direct-vendor endpoint logo renders on the SAME
// fixed light chip as community icons, instead of a raw theme-tinted glyph.
const logoSvgCache = new Map<string, string>();
const logoSvgInflight = new Map<string, Promise<string | null>>();

/** Default when a model isn't found in the catalog. */
export const DEFAULT_CONTEXT_LIMIT = 128000;

type InfoMap = Record<string, ModelInfo>;

let memoryCache: InfoMap | null = null;
let inflight: Promise<InfoMap> | null = null;
// Canonical <provider>/<model> → owner-provider map, loaded alongside the info
// map. Best-effort; null until it's loaded once (falls back to the shared
// brand heuristic in logoProviderFor).
let canonicalCache: Record<string, string> | null = null;
let canonicalInflight: Promise<Record<string, string> | null> | null = null;

// Subscribe API: a version counter bumped whenever the in-memory catalog
// changes, so useSyncExternalStore consumers re-render after a background load.
let version = 0;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/** Subscribe to catalog changes; returns an unsubscribe fn. */
export function subscribeModelCatalog(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Snapshot for useSyncExternalStore — stable until the catalog (re)loads. */
export function getModelCatalogVersion(): number {
  return version;
}

export { normalizeModelId as normalizeId } from "../../shared/models/model-catalog";

function readSetting(key: string): string | null {
  if (typeof localStorage === "undefined") return null;
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeSetting(key: string, value: string): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(key, value);
  } catch {
    // best-effort (quota / private mode)
  }
}

/** Load the cached info map from localStorage (if fresh), else null. Entries are
 *  normalized so a cache written by an older build (pre-`modes` shape) can't
 *  crash consumers. */
function loadCache(): InfoMap | null {
  const at = Number(readSetting(CACHE_AT_KEY) ?? 0);
  if (!at || Date.now() - at > CACHE_TTL_MS) return null;
  const raw = readSetting(CACHE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, ModelInfo>;
    const map: InfoMap = {};
    for (const [id, info] of Object.entries(parsed)) {
      const norm = normalizeModelInfo(info);
      if (norm) map[id] = norm;
    }
    return map;
  } catch {
    return null;
  }
}

/** Load the cached canonical owner map from localStorage (if fresh), else null. */
function loadCanonicalCache(): Record<string, string> | null {
  const at = Number(readSetting(CANONICAL_CACHE_AT_KEY) ?? 0);
  if (!at || Date.now() - at > CACHE_TTL_MS) return null;
  const raw = readSetting(CANONICAL_CACHE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Record<string, string>;
  } catch {
    return null;
  }
}

/**
 * Ensure the canonical owner map is loaded (memory → localStorage → network).
 * Never throws; returns null on total failure. De-duped, and bumps the version
 * so pickers re-render once the authoritative owners arrive.
 */
async function ensureCanonical(): Promise<Record<string, string> | null> {
  if (canonicalCache) return canonicalCache;
  const cached = loadCanonicalCache();
  if (cached) {
    canonicalCache = cached;
    version += 1;
    emit();
    return cached;
  }
  if (canonicalInflight) return canonicalInflight;
  canonicalInflight = (async () => {
    try {
      const res = await fetch(CANONICAL_URL, { headers: { Accept: "application/json" } });
      if (!res.ok) throw new Error(`models.dev canonical ${res.status}`);
      const map = parseCanonicalCatalog(await res.json());
      canonicalCache = map;
      version += 1;
      writeSetting(CANONICAL_CACHE_KEY, JSON.stringify(map));
      writeSetting(CANONICAL_CACHE_AT_KEY, String(Date.now()));
      emit();
      return map;
    } catch {
      return null;
    } finally {
      canonicalInflight = null;
    }
  })();
  return canonicalInflight;
}

/**
 * Ensure the id→info map is loaded (memory → localStorage → network).
 * Best-effort; returns an empty map on total failure. Safe to call repeatedly;
 * de-duped. Emits on every successful load so subscribers re-render.
 */
async function ensureMap(): Promise<InfoMap> {
  // Warm the canonical owner map alongside the info map (de-duped; returns
  // immediately when already loaded or in-flight).
  void ensureCanonical();
  if (memoryCache) return memoryCache;
  const cached = loadCache();
  if (cached) {
    memoryCache = cached;
    version += 1;
    emit();
    pushModelPricingToMain();
    return cached;
  }
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const res = await fetch(API_URL, { headers: { Accept: "application/json" } });
      if (!res.ok) throw new Error(`models.dev ${res.status}`);
      const map = parseModelCatalog(await res.json());
      memoryCache = map;
      version += 1;
      writeSetting(CACHE_KEY, JSON.stringify(map));
      writeSetting(CACHE_AT_KEY, String(Date.now()));
      emit();
      pushModelPricingToMain();
      return map;
    } catch {
      // Don't cache the empty result — leaving memoryCache unset lets the next
      // ensureMap() call retry (inflight still de-dupes concurrent callers).
      return {};
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/**
 * Synchronous catalog lookup from the in-memory cache. Returns null until the
 * catalog has been loaded at least once (call prewarmModelCatalog()/modelInfoForModel()
 * and subscribe via subscribeModelCatalog to know when data arrives).
 */
export function getModelInfo(modelId: string): ModelInfo | null {
  if (!modelId || !memoryCache) return null;
  return lookupModelInfo(memoryCache, modelId);
}

/**
 * Async lookup that loads/refreshes the catalog first. Results are cached in
 * memory + localStorage. Never throws.
 */
export async function modelInfoForModel(modelId: string): Promise<ModelInfo | null> {
  if (!modelId) return null;
  const map = await ensureMap();
  return lookupModelInfo(map, modelId);
}

/**
 * Context window (tokens) for a model id, or `fallback` when unknown. Tries an
 * exact catalog match first, then a normalized/fuzzy match so proxy or gateway
 * ids (e.g. "playground-claude-opus-4-8") resolve to the underlying model.
 * Async so it can fetch/refresh the catalog; never throws.
 */
export async function contextLimitForModel(
  modelId: string,
  fallback = DEFAULT_CONTEXT_LIMIT,
): Promise<number> {
  if (!modelId) return fallback;
  return (await modelInfoForModel(modelId))?.context ?? fallback;
}

/** Warm the catalog cache in the background (best-effort, fire-and-forget). */
export function prewarmModelCatalog(): void {
  void ensureMap();
}

/**
 * The compact `modelId → { input, output }` per-1M pricing map (USD), sent to
 * the main process so the usage recorder can estimate cost for providers that
 * don't report it. Best-effort — no-op when the catalog isn't loaded yet or no
 * Electron bridge exists.
 */
export function getModelPricingMap(): Record<string, { input: number | null; output: number | null }> {
  const src = memoryCache ?? loadCache() ?? {};
  const out: Record<string, { input: number | null; output: number | null }> = {};
  for (const [id, info] of Object.entries(src)) {
    if (info.input == null && info.output == null) continue;
    out[id] = { input: info.input ?? null, output: info.output ?? null };
  }
  return out;
}

/** Push the pricing map to the Electron main process (usage recorder). */
export function pushModelPricingToMain(): void {
  if (typeof window === "undefined" || !window.electron?.usage?.setPricing) return;
  try {
    // Silently swallow a rejected pricing push — the main process just keeps
    // its previous (or empty) pricing map; estimation stays best-effort.
    window.electron.usage.setPricing(getModelPricingMap()).catch(() => {});
  } catch {
    // best-effort (e.g. no IPC bridge yet)
  }
}

/**
 * The `max_tokens` to send for a chat request, or `undefined` to omit the field.
 * `userOverride` is the user's explicit "Max output tokens" (undefined/0 = Auto,
 * which omits the cap so the model finishes naturally). Kept async for a stable
 * call site even though it no longer needs the catalog.
 */
export async function maxOutputTokensForModel(
  userOverride?: number | null,
): Promise<number | undefined> {
  return resolveMaxOutputTokens(userOverride);
}

/**
 * The provider slug whose logo identifies `modelId`. Prefers the canonical
 * owner from models.json, then the brand heuristic, then the flattened
 * catalog's provider. Best-effort — null when nothing resolves.
 */
export function getLogoProvider(modelId: string): string | null {
  if (!modelId) return null;
  return logoProviderFor(modelId, getModelInfo(modelId)?.provider ?? null, canonicalCache);
}

/** models.dev logo URL for `modelId`, or null when nothing resolves. */
export function modelLogoUrl(modelId: string): string | null {
  const provider = getLogoProvider(modelId);
  return provider ? providerLogoUrl(provider) : null;
}

/**
 * Fetch a models.dev provider logo as inline SVG markup, cached in memory. The
 * returned string is safe to hand to ConnectorLogo (passes its looksSafeSvg
 * guard): models.dev logos are single-colour `fill="currentColor"` marks.
 * Returns null while the logo hasn't fetched yet (the caller falls back to the
 * generic glyph). Bumps the catalog version on arrival so subscribers re-render.
 */
export function getLogoSvg(slug: string): string | null {
  return logoSvgCache.get(slug) ?? null;
}

const logoSvgSubscribers = new Set<() => void>();
/** Subscribe to logo-svg availability changes (fires after each new fetch). */
export function subscribeLogoSvg(listener: () => void): () => void {
  logoSvgSubscribers.add(listener);
  return () => { logoSvgSubscribers.delete(listener); };
}

function fetchLogoSvg(slug: string): void {
  if (logoSvgCache.has(slug) || logoSvgInflight.has(slug)) return;
  const p = (async () => {
    try {
      const res = await fetch(providerLogoUrl(slug), { headers: { Accept: "image/svg+xml" } });
      if (!res.ok) return null;
      const text = await res.text();
      if (!/^\s*<svg[\s>]/i.test(text) || !/<\/svg>\s*$/i.test(text)) return null;
      logoSvgCache.set(slug, text);
      version += 1;
      emit();
      for (const l of logoSvgSubscribers) l();
      return text;
    } catch {
      return null;
    } finally {
      logoSvgInflight.delete(slug);
    }
  })();
  logoSvgInflight.set(slug, p);
}

/**
 * Resolve a models.dev provider slug to inline SVG markup (cached, lazy-fetched).
 * When the SVG isn't cached yet, kicks off a fetch and returns null (caller
 * should render the generic glyph meanwhile and re-render once it arrives —
 * subscribe via subscribeLogoSvg/useSyncExternalStore).
 */
export function getOrFetchLogoSvg(slug: string): string | null {
  const cached = logoSvgCache.get(slug);
  if (cached) return cached;
  fetchLogoSvg(slug);
  return null;
}

/**
 * React hook: inline SVG markup for a models.dev provider slug, or null while
 * pending/failed. Re-renders when the SVG lands (via the subscribeLogoSvg store).
 */
export function useLogoSvg(slug: string | null | undefined): string | null {
  const v = useSyncExternalStore(subscribeLogoSvg, getModelCatalogVersion);
  void v; // re-render trigger only
  if (!slug) return null;
  return getOrFetchLogoSvg(slug);
}
