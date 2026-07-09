/**
 * models.dev context-window lookup for the chat context ring.
 *
 * Fetches the public models.dev catalog (https://models.dev/api.json) and maps a
 * model id → its context window (limit.context). Used to size the ring for the
 * OpenAI-compatible provider, where the model id is known. Rork's underlying
 * model is uncertain, so it uses a fixed conservative cap instead (not this).
 *
 * The catalog is ~3MB, so we fetch it at most once per app run (in-memory) and
 * persist the small id→context map to the app_settings table so subsequent runs
 * resolve instantly and offline. Everything is best-effort: on any failure the
 * caller falls back to a default limit.
 */

import { fetch as expoFetch } from "expo/fetch";
import { getDb } from "../db";

const API_URL = "https://models.dev/api.json";
const CACHE_KEY = "ai.modelContext.cache"; // JSON { [modelId]: contextTokens }
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // refresh weekly
const CACHE_AT_KEY = "ai.modelContext.cachedAt";

/** Default when a model isn't found in the catalog. */
export const DEFAULT_CONTEXT_LIMIT = 65536;

type ContextMap = Record<string, number>;

let memoryCache: ContextMap | null = null;
let inflight: Promise<ContextMap> | null = null;

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

/** Flatten the models.dev catalog into a single id → context-window map. */
function buildMap(catalog: unknown): ContextMap {
  const map: ContextMap = {};
  if (!catalog || typeof catalog !== "object") return map;
  for (const provider of Object.values(catalog as Record<string, unknown>)) {
    const models = (provider as { models?: unknown })?.models;
    if (!models || typeof models !== "object") continue;
    for (const [id, model] of Object.entries(models as Record<string, unknown>)) {
      const ctx = (model as { limit?: { context?: unknown } })?.limit?.context;
      if (typeof ctx === "number" && ctx > 0) map[id] = ctx;
    }
  }
  return map;
}

/** Load the cached map from SQLite (if fresh), else null. */
function loadCache(): ContextMap | null {
  const at = Number(readSetting(CACHE_AT_KEY) ?? 0);
  if (!at || Date.now() - at > CACHE_TTL_MS) return null;
  const raw = readSetting(CACHE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ContextMap;
  } catch {
    return null;
  }
}

/**
 * Ensure the id→context map is loaded (memory → SQLite → network). Best-effort;
 * returns an empty map on total failure. Safe to call repeatedly; de-duped.
 */
async function ensureMap(): Promise<ContextMap> {
  if (memoryCache) return memoryCache;
  const cached = loadCache();
  if (cached) {
    memoryCache = cached;
    return cached;
  }
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const res = await expoFetch(API_URL, { headers: { Accept: "application/json" } });
      if (!res.ok) throw new Error(`models.dev ${res.status}`);
      const map = buildMap(await res.json());
      memoryCache = map;
      writeSetting(CACHE_KEY, JSON.stringify(map));
      writeSetting(CACHE_AT_KEY, String(Date.now()));
      return map;
    } catch {
      memoryCache = {};
      return {};
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/**
 * Context window (tokens) for a model id, or `fallback` when unknown. Async so it
 * can fetch/refresh the catalog; results are cached in memory + SQLite. Never
 * throws.
 */
export async function contextLimitForModel(
  modelId: string,
  fallback = DEFAULT_CONTEXT_LIMIT,
): Promise<number> {
  if (!modelId) return fallback;
  const map = await ensureMap();
  return map[modelId] ?? fallback;
}

/** Warm the catalog cache in the background (best-effort, fire-and-forget). */
export function prewarmModelCatalog(): void {
  void ensureMap();
}
