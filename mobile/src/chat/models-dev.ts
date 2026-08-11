/**
 * models.dev model-catalog lookup (mobile).
 *
 * Fetches the public models.dev catalog (https://models.dev/api.json) and maps a
 * model id → model metadata (context window, per-1M-token input/output cost,
 * image-input support, tool-calling, owning provider logo). Consumers:
 *  - the chat context ring auto-sizes from `contextLimitForModel` (Rork's
 *    underlying model is uncertain, so it uses a fixed conservative cap instead)
 *  - the AI settings model list shows per-model cost, provider logo, and
 *    image/tool markers
 *
 * The catalog is ~3MB, so we fetch it at most once per app run (in-memory) and
 * persist the compact id→info map to the app_settings table so subsequent runs
 * resolve instantly and offline. Everything is best-effort: on any failure the
 * caller falls back to a default limit.
 *
 * Parsing / normalization / formatting live in shared/models/model-catalog.ts
 * (shared with desktop). This file is the mobile fetch + SQLite persistence + a
 * tiny subscribe API so React components re-render once the catalog arrives.
 */

import { fetch as expoFetch } from "expo/fetch";
import {
  logoProviderFor,
  lookupModelInfo,
  normalizeModelInfo,
  parseCanonicalCatalog,
  parseModelCatalog,
  providerLogoUrl,
  type ModelInfo,
} from "@cairn/shared/models/model-catalog";
import { getDb } from "../db";

const API_URL = "https://models.dev/api.json";
// v2: bumped when the parsed ModelInfo shape gains a field (maxOutput) so
// existing caches re-fetch immediately instead of waiting out the weekly TTL.
const CACHE_KEY = "ai.modelInfo.cache.v2"; // JSON { [modelId]: ModelInfo }
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // refresh weekly
const CACHE_AT_KEY = "ai.modelInfo.cachedAt.v2";
// Canonical owner map (models.json): id → provider slug for logo resolution.
// Tiny (282 entries) and keyed by canonical "<provider>/<model>" ids, so it's
// cached separately with its own freshness window.
const CANONICAL_URL = "https://models.dev/models.json";
const CANONICAL_CACHE_KEY = "ai.canonical.cache"; // JSON { [canonicalId]: provider }
const CANONICAL_CACHE_AT_KEY = "ai.canonical.cachedAt";

/** Default when a model isn't found in the catalog. */
export const DEFAULT_CONTEXT_LIMIT = 65536;

type InfoMap = Record<string, ModelInfo>;

let memoryCache: InfoMap | null = null;
let inflight: Promise<InfoMap> | null = null;
// Canonical <provider>/<model> → owner-provider map, loaded alongside the info
// map. Best-effort; null until it's loaded once (falls back to the shared
// brand heuristic in logoProviderFor).
let canonicalCache: Record<string, string> | null = null;
let canonicalInflight: Promise<Record<string, string> | null> | null = null;

// In-memory cache of fetched models.dev provider logo SVG strings (per slug):
// shared by ConnectorLogo so a direct-vendor endpoint logo renders on the SAME
// fixed light chip as community icons, instead of a raw theme-tinted glyph.
const logoSvgCache = new Map<string, string>();
const logoSvgInflight = new Map<string, Promise<string | null>>();

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

export { normalizeModelId as normalizeId } from "@cairn/shared/models/model-catalog";

function readSetting(key: string): string | null {
  try {
    const row = getDb().getFirstSync<{ value: string }>(
      "SELECT value FROM app_settings WHERE key = ?",
      key,
    );
    return row?.value ?? null;
  } catch {
    return null;
  }
}

function writeSetting(key: string, value: string): void {
  try {
    getDb().runSync(
      "INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      key,
      value,
    );
  } catch {
    // best-effort
  }
}

/** Load the cached info map from SQLite (if fresh), else null. Entries are
 * normalized so a cache written by an older build (pre-`modes` shape) can't
 * crash consumers. */
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

/** Load the cached canonical owner map from SQLite (if fresh), else null. */
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
 * Ensure the canonical owner map is loaded (memory → SQLite → network).
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
      const res = await expoFetch(CANONICAL_URL, { headers: { Accept: "application/json" } });
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
 * Ensure the id→info map is loaded (memory → SQLite → network). Best-effort;
 * returns an empty map on total failure. Safe to call repeatedly; de-duped.
 * Emits on every successful load so subscribers re-render.
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
      const res = await expoFetch(API_URL, { headers: { Accept: "application/json" } });
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
 * Resolve PRICED model info: the exact/normalized lookup first, then the same
 * fuzzy match desktop's pricePerMillion uses (a gateway/proxy id that embeds a
 * catalog id as a whole token, e.g. "opencode-go/deepseek-v4-flash"). Catalog
 * entries with NO pricing (models.dev lists some bare ids and `:free` variants
 * with an empty/zero cost) are skipped, so the fuzzy pass lands on a PRICED
 * variant (e.g. `deepseek-v4-flash` → `deepseek/deepseek-v4-flash`) instead of
 * reporting nothing.
 */
export function getPricedModelInfo(modelId: string): ModelInfo | null {
  const hasPricing = (info: ModelInfo) => (info.input ?? 0) > 0 || (info.output ?? 0) > 0;
  const resolvePriced = (id: string): ModelInfo | null => {
    const direct = getModelInfo(id);
    if (direct && hasPricing(direct)) return direct;
    const map = memoryCache;
    if (!map) return null;
    const base = id.toLowerCase();
    const boundary = (s: string, start: number) => start === 0 || /[-/:._]/.test(s[start - 1] ?? "");
    for (const [catId, info] of Object.entries(map)) {
      if (!hasPricing(info)) continue;
      const nid = catId.toLowerCase();
      if (nid && base.endsWith(nid) && boundary(base, base.length - nid.length)) return info;
      if (nid.endsWith(base) && boundary(nid, nid.length - base.length)) return info;
    }
    return null;
  };
  const priced = resolvePriced(modelId);
  if (priced) return priced;
  // Retry with trailing qualifier segments stripped — handles region / date /
  // reasoning suffixes (deepseek-v4-flash-gcp, deepseek-v4-flash-0731-gcp,
  // deepseek-v4-flash:thinking) that no catalog id carries verbatim.
  let candidate = modelId;
  for (let i = 0; i < 3; i++) {
    const next = candidate.replace(/[-:.][a-z0-9]+$/i, "");
    if (next === candidate || !next) break;
    candidate = next;
    const hit = resolvePriced(candidate);
    if (hit) return hit;
  }
  return null;
}

/** The raw in-memory catalog map (null until loaded once). */
export function getModelCatalogMap(): Record<string, ModelInfo> | null {
  return memoryCache;
}

/**
 * Async lookup that loads/refreshes the catalog first. Results are cached in
 * memory + SQLite. Never throws.
 */
export async function modelInfoForModel(modelId: string): Promise<ModelInfo | null> {
  if (!modelId) return null;
  const map = await ensureMap();
  return lookupModelInfo(map, modelId);
}

/**
 * Context window (tokens) for a model id, or `fallback` when unknown. Tries an
 * exact catalog match first, then a normalized/fuzzy match so proxy or gateway
 * ids resolve to the underlying model. Async so it can fetch/refresh the
 * catalog; results are cached in memory + SQLite. Never throws.
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

function fetchLogoSvg(slug: string): void {
  if (logoSvgCache.has(slug) || logoSvgInflight.has(slug)) return;
  const p = (async () => {
    try {
      const res = await fetch(providerLogoUrl(slug), { headers: { Accept: "image/svg+xml" } });
      if (!res.ok) return null;
      const text = await res.text();
      // Same shape guard as desktop: must look like an SVG document.
      if (!/^\s*<svg[\s>]/i.test(text) || !/<\/svg>\s*$/i.test(text)) return null;
      logoSvgCache.set(slug, text);
      version += 1;
      emit();
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
 * Returns null while the SVG isn't cached yet and kicks off a fetch; callers
 * should render a generic glyph meanwhile and re-render once it arrives (the
 * version bump via subscribeModelCatalog/getModelCatalogVersion powers that).
 */
export function getOrFetchLogoSvg(slug: string): string | null {
  const cached = logoSvgCache.get(slug);
  if (cached) return cached;
  fetchLogoSvg(slug);
  return null;
}
