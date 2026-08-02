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

import {
  logoProviderFor,
  lookupModelInfo,
  normalizeModelInfo,
  parseCanonicalCatalog,
  parseModelCatalog,
  providerLogoUrl,
  type ModelInfo,
} from "../../shared/models/model-catalog";

const API_URL = "https://models.dev/api.json";
const CACHE_KEY = "ai.modelInfo.cache"; // JSON { [modelId]: ModelInfo }
const CACHE_AT_KEY = "ai.modelInfo.cachedAt";
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // refresh weekly
// Canonical owner map (models.json): id → provider slug for logo resolution.
// Tiny (282 entries) and keyed by canonical "<provider>/<model>" ids, so it's
// cached separately with its own freshness window.
const CANONICAL_URL = "https://models.dev/models.json";
const CANONICAL_CACHE_KEY = "ai.canonical.cache"; // JSON { [canonicalId]: provider }
const CANONICAL_CACHE_AT_KEY = "ai.canonical.cachedAt";

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
