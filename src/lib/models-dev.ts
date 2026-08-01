/**
 * models.dev context-window lookup for the chat context ring (desktop).
 *
 * Fetches the public models.dev catalog (https://models.dev/api.json) and maps a
 * model id → its context window (limit.context). Used to auto-size the context
 * ring for the OpenAI-compatible (Cloud / Local API) provider, where the model
 * id is known.
 *
 * The catalog is ~3MB, so we fetch it at most once per app run (in-memory) and
 * persist the small id→context map to localStorage so subsequent runs resolve
 * instantly and offline. Everything is best-effort: on any failure the caller
 * falls back to a default limit.
 *
 * Ported from the mobile implementation (mobile/src/chat/models-dev.ts), swapping
 * expo/fetch + SQLite app_settings for the browser fetch + localStorage.
 */

const API_URL = "https://models.dev/api.json";
const CACHE_KEY = "ai.modelContext.cache"; // JSON { [modelId]: contextTokens }
const CACHE_AT_KEY = "ai.modelContext.cachedAt";
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // refresh weekly

/** Default when a model isn't found in the catalog. */
export const DEFAULT_CONTEXT_LIMIT = 128000;

type ContextMap = Record<string, number>;

let memoryCache: ContextMap | null = null;
// Lazily-built normalized index (normalized id → context) for fuzzy matching.
// Rebuilt whenever memoryCache changes (tracked by identity).
let normIndex: ContextMap | null = null;
let normIndexFor: ContextMap | null = null;
let inflight: Promise<ContextMap> | null = null;

/**
 * Normalize a model id to a canonical form so proxy/gateway variants resolve to
 * the underlying catalog entry. Handles:
 *  - provider path/dotted prefixes: `anthropic/…`, `us.anthropic.…`, `~anthropic/…`
 *  - gateway/vendor prefixes: `playground-`, `databricks-`, `duo-chat-`, `anthropic--`, `stealth/`
 *  - variant suffixes: `:thinking`, `@default`, `-thinking`, `-fast`, `-latest`, dates, `-v1:0`
 * The result is lowercase with those decorations stripped. Not exhaustive — just
 * enough to catch the common real-world proxy id shapes.
 */
export function normalizeId(id: string): string {
  let s = id.toLowerCase().trim();
  // Strip a leading gateway "provider:" prefix that some endpoints prepend to the
  // model id (e.g. "merge:deepseek/deepseek-v4-flash" → "deepseek/deepseek-v4-flash",
  // "merge:deepseek-v4-flash" → "deepseek-v4-flash"). Only a single leading segment
  // before the first ":" that is *not* followed by more colons (thinking budgets /
  // versions use ":" too, but those come after the model name and still carry a "/"
  // or are handled by the later ":" split). We only strip when what follows still
  // looks like a model id (contains "/" or "-"), so we don't clobber ids like
  // "gpt-4:thinking".
  const providerPrefix = s.match(/^([a-z0-9_-]+):(.+)$/);
  if (providerPrefix && /[/-]/.test(providerPrefix[2])) {
    s = providerPrefix[2];
  }
  // Keep only the last path segment (e.g. "anthropic/claude-opus-4" → "claude-opus-4").
  if (s.includes("/")) s = s.split("/").pop() as string;
  // Strip a leading "~" (some gateways prefix aliases with it).
  s = s.replace(/^~/, "");
  // Strip region + vendor dotted prefixes: "us.anthropic.", "anthropic.", "eu.".
  s = s.replace(/^[a-z]{2}\.anthropic\./, "").replace(/^anthropic\./, "").replace(/^[a-z]{2}\./, "");
  // Drop everything after ":" or "@" (thinking budgets, versions, dates).
  s = s.split(":")[0].split("@")[0];
  // Strip common gateway/vendor prefixes.
  s = s.replace(
    /^(playground-|databricks-|duo-chat-|anthropic--|anthropic-|stealth-|global\.|us\.|eu\.|au\.|jp\.)/,
    "",
  );
  // Strip trailing variant suffixes.
  s = s.replace(/-(thinking|think|fast|free|latest|reasoning|distilled)$/, "");
  // Strip trailing dates ("-20250514") and pure version tags ("-v1", "-v1:0").
  // The version tag may only continue with dot/colon-separated numbers — it must
  // NOT swallow a trailing word like "-flash" or "-luna" (e.g. "deepseek-v4-flash"
  // must stay intact, not collapse to "deepseek").
  s = s.replace(/-\d{6,8}$/, "").replace(/-v\d+([.:]\d+)*$/, "");
  return s;
}

/** Build (and memoize) the normalized-id index for the current map. */
function getNormIndex(map: ContextMap): ContextMap {
  if (normIndex && normIndexFor === map) return normIndex;
  const idx: ContextMap = {};
  for (const [id, ctx] of Object.entries(map)) {
    const n = normalizeId(id);
    // First writer wins — exact-looking short ids tend to be enumerated first,
    // but any catalog value for a normalized key is acceptable for our purpose.
    if (!(n in idx)) idx[n] = ctx;
  }
  normIndex = idx;
  normIndexFor = map;
  return idx;
}

/** Resolve a model id to a context window via exact → normalized → separator-variant. */
function lookup(map: ContextMap, modelId: string): number | null {
  if (map[modelId] != null) return map[modelId];
  const idx = getNormIndex(map);
  const n = normalizeId(modelId);
  if (idx[n] != null) return idx[n];
  // Try swapping version separators both ways (e.g. "4-8" ⇄ "4.8").
  const dashToDot = n.replace(/(\d)-(\d)/g, "$1.$2");
  if (idx[dashToDot] != null) return idx[dashToDot];
  const dotToDash = n.replace(/(\d)\.(\d)/g, "$1-$2");
  if (idx[dotToDash] != null) return idx[dotToDash];
  return null;
}

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

/** Load the cached map from localStorage (if fresh), else null. */
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
 * Ensure the id→context map is loaded (memory → localStorage → network).
 * Best-effort; returns an empty map on total failure. Safe to call repeatedly;
 * de-duped.
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
      const res = await fetch(API_URL, { headers: { Accept: "application/json" } });
      if (!res.ok) throw new Error(`models.dev ${res.status}`);
      const map = buildMap(await res.json());
      memoryCache = map;
      writeSetting(CACHE_KEY, JSON.stringify(map));
      writeSetting(CACHE_AT_KEY, String(Date.now()));
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
 * Context window (tokens) for a model id, or `fallback` when unknown. Tries an
 * exact catalog match first, then a normalized/fuzzy match so proxy or gateway
 * ids (e.g. "playground-claude-opus-4-8") resolve to the underlying model.
 * Async so it can fetch/refresh the catalog; results are cached in memory +
 * localStorage. Never throws.
 */
export async function contextLimitForModel(
  modelId: string,
  fallback = DEFAULT_CONTEXT_LIMIT,
): Promise<number> {
  if (!modelId) return fallback;
  const map = await ensureMap();
  return lookup(map, modelId) ?? fallback;
}

/** Warm the catalog cache in the background (best-effort, fire-and-forget). */
export function prewarmModelCatalog(): void {
  void ensureMap();
}
