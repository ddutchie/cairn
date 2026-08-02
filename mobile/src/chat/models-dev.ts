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
  lookupModelInfo,
  normalizeModelInfo,
  parseModelCatalog,
  type ModelInfo,
} from "@cairn/shared/models/model-catalog";
import { getDb } from "../db";

const API_URL = "https://models.dev/api.json";
const CACHE_KEY = "ai.modelInfo.cache"; // JSON { [modelId]: ModelInfo }
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // refresh weekly
const CACHE_AT_KEY = "ai.modelInfo.cachedAt";

/** Default when a model isn't found in the catalog. */
export const DEFAULT_CONTEXT_LIMIT = 65536;

type InfoMap = Record<string, ModelInfo>;

let memoryCache: InfoMap | null = null;
let inflight: Promise<InfoMap> | null = null;

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

/**
 * Ensure the id→info map is loaded (memory → SQLite → network). Best-effort;
 * returns an empty map on total failure. Safe to call repeatedly; de-duped.
 * Emits on every successful load so subscribers re-render.
 */
async function ensureMap(): Promise<InfoMap> {
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
