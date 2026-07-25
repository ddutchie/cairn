/**
 * AI configuration store (local-only, on-device).
 *
 * Two backends, chosen by secrecy:
 *   - Non-secret config (OpenAI-compatible base URL + model + provider) lives in
 *     the DEVICE-GLOBAL meta DB (`getMeta`/`setMeta`) — local-only, never synced,
 *     and shared across all workspace sources. It deliberately does NOT live in a
 *     source's `app_settings` table: that DB is per-workspace and is wiped/rebuilt
 *     from the oplog, so config stored there was lost on upgrade and diverged when
 *     switching workspaces (the "endpoint resets on restart" bug).
 *   - The API key (a secret) lives in expo-secure-store (iOS keychain /
 *     Android keystore), never in SQLite and never synced. It was already global.
 *
 * Provider selection (see providers/index.ts):
 *   - If the build injected a Rork toolkit URL (EXPO_PUBLIC_TOOLKIT_URL), the
 *     app uses Rork with zero config.
 *   - Otherwise it uses the OpenAI-compatible provider configured here. This is
 *     the path for third-party builders: bring your own endpoint + key, so the
 *     app never leans on our unauthenticated Rork endpoint.
 */

import * as SecureStore from "expo-secure-store";
import { getMeta, setMeta, getDb } from "../db";
import type { AppleReasoningLevel } from "@modules/apple-llm";

const KEY_BASE_URL = "ai.openai.baseUrl";
const KEY_MODEL = "ai.openai.model";
const KEY_CONTEXT = "ai.openai.contextLimit"; // optional manual override (tokens)
const KEY_PROVIDER = "ai.provider"; // "rork" | "openai" | "apple"
const KEY_APPLE_REASONING = "ai.apple.reasoningLevel"; // "light" | "moderate" | "deep"
const SECURE_KEY_APIKEY = "ai.openai.apiKey"; // secure-store key (legacy single key)

/** Saved OpenAI-compatible connections (JSON array) + the active one's id. */
const KEY_SAVED_PROVIDERS = "ai.openai.providers";
const KEY_ACTIVE_PROVIDER = "ai.openai.activeProviderId";
/** Per-provider secure-store key prefix for API keys (kept out of SQLite). */
const SECURE_KEY_PROVIDER_PREFIX = "ai.openai.apiKey.";
/** One-time flag guarding the flat-config → saved-providers migration. */
const PROVIDERS_MIGRATION_FLAG = "ai.openai.providersMigrated";

/** Keys migrated once from the (per-workspace) app_settings table to meta. */
const MIGRATED_KEYS = [KEY_BASE_URL, KEY_MODEL, KEY_CONTEXT, KEY_PROVIDER, KEY_APPLE_REASONING];
const MIGRATION_FLAG = "ai.config.migratedToMeta";

/**
 * Which backend the user prefers when more than one is available.
 *   - "apple": Apple Intelligence — Private Cloud Compute (iOS 27+, no key,
 *     privacy-preserving) when available, else the dev on-device model.
 *   - "rork":  built-in first-party endpoint (network)
 *   - "openai": user-supplied OpenAI-compatible endpoint (network)
 */
export type ProviderPref = "rork" | "openai" | "apple";

/** Sensible default for an OpenAI-compatible endpoint. */
export const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
export const DEFAULT_OPENAI_MODEL = "gpt-4.1-mini";

export interface OpenAIConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
  /** Optional manual context-window override (tokens) for the ring, when the
   *  model isn't in the models.dev catalog. Undefined = use catalog/default. */
  contextLimit?: number;
}

/**
 * A named, reusable OpenAI-compatible connection. Lets the user save several
 * endpoints (e.g. "OpenAI", "OpenRouter", "Local Ollama") and switch the active
 * one without retyping the base URL, key, and model. The non-secret fields live
 * in the meta DB; each provider's API key lives in secure-store keyed by id.
 */
export interface SavedProvider {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  /** Optional manual context-window override (tokens). */
  contextLimit?: number;
}

/** Generate a short, stable provider id. */
function newProviderId(): string {
  return `p_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}

function readProviders(): SavedProvider[] {
  const raw = getSetting(KEY_SAVED_PROVIDERS);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (p): p is SavedProvider =>
        p && typeof p.id === "string" && typeof p.name === "string" && typeof p.baseUrl === "string",
    );
  } catch {
    return [];
  }
}

function writeProviders(list: SavedProvider[]): void {
  setSetting(KEY_SAVED_PROVIDERS, JSON.stringify(list));
}

function secureKeyFor(id: string): string {
  return `${SECURE_KEY_PROVIDER_PREFIX}${id}`;
}

/**
 * One-time migration: fold the pre-existing flat OpenAI config (baseUrl/model/
 * contextLimit + the single secure-store API key) into the saved-providers list
 * as a default "OpenAI" provider, and mark it active. Idempotent, guarded by a
 * meta flag. Best-effort — the flat getters keep working regardless.
 */
async function migrateToProvidersOnce(): Promise<void> {
  if (getSetting(PROVIDERS_MIGRATION_FLAG) === "1") return;
  // Only run once there's a source DB to read/write meta from.
  try {
    if (readProviders().length > 0) {
      setSetting(PROVIDERS_MIGRATION_FLAG, "1");
      return;
    }
    const baseUrl = getSetting(KEY_BASE_URL)?.trim() || DEFAULT_OPENAI_BASE_URL;
    const model = getSetting(KEY_MODEL)?.trim() || DEFAULT_OPENAI_MODEL;
    const contextLimit = getOpenAIContextLimit();
    const legacyKey = (await getLegacyApiKey()) ?? "";
    const id = newProviderId();
    writeProviders([{ id, name: "OpenAI", baseUrl, model, contextLimit }]);
    setSetting(KEY_ACTIVE_PROVIDER, id);
    if (legacyKey) await SecureStore.setItemAsync(secureKeyFor(id), legacyKey).catch(() => {});
    setSetting(PROVIDERS_MIGRATION_FLAG, "1");
  } catch {
    // No source yet — retry on next access (don't set the flag).
  }
}

/** List saved providers (runs the flat→list migration first). */
export async function listSavedProviders(): Promise<SavedProvider[]> {
  await migrateToProvidersOnce();
  return readProviders();
}

/** Id of the active saved provider, or null. */
export function getActiveProviderId(): string | null {
  return getSetting(KEY_ACTIVE_PROVIDER);
}

/** The active saved provider, or null if none. */
export function getActiveProvider(): SavedProvider | null {
  const id = getActiveProviderId();
  const list = readProviders();
  return list.find((p) => p.id === id) ?? list[0] ?? null;
}

/** Read a provider's API key from secure-store (null if none). */
export async function getProviderApiKey(id: string): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(secureKeyFor(id));
  } catch {
    return null;
  }
}

/**
 * Create a saved provider, store its key in secure-store, select it, and return
 * its id. `apiKey` may be empty for keyless local servers.
 */
export async function addSavedProvider(input: {
  name: string;
  baseUrl: string;
  model: string;
  apiKey?: string;
  contextLimit?: number;
}): Promise<string> {
  await migrateToProvidersOnce();
  const id = newProviderId();
  const list = readProviders();
  list.push({
    id,
    name: input.name.trim() || "Provider",
    baseUrl: input.baseUrl.trim() || DEFAULT_OPENAI_BASE_URL,
    model: input.model.trim() || DEFAULT_OPENAI_MODEL,
    contextLimit: input.contextLimit && input.contextLimit > 0 ? Math.floor(input.contextLimit) : undefined,
  });
  writeProviders(list);
  setSetting(KEY_ACTIVE_PROVIDER, id);
  if (input.apiKey?.trim()) await SecureStore.setItemAsync(secureKeyFor(id), input.apiKey.trim());
  return id;
}

/** Update a saved provider's non-secret fields and (optionally) its API key. */
export async function updateSavedProvider(
  id: string,
  patch: { name?: string; baseUrl?: string; model?: string; contextLimit?: number | undefined; apiKey?: string },
): Promise<void> {
  const list = readProviders().map((p) =>
    p.id === id
      ? {
          ...p,
          name: patch.name?.trim() ?? p.name,
          baseUrl: patch.baseUrl?.trim() ?? p.baseUrl,
          model: patch.model?.trim() ?? p.model,
          contextLimit:
            patch.contextLimit === undefined
              ? p.contextLimit
              : patch.contextLimit && patch.contextLimit > 0
                ? Math.floor(patch.contextLimit)
                : undefined,
        }
      : p,
  );
  writeProviders(list);
  if (patch.apiKey !== undefined) {
    const trimmed = patch.apiKey.trim();
    if (trimmed) await SecureStore.setItemAsync(secureKeyFor(id), trimmed);
    else await SecureStore.deleteItemAsync(secureKeyFor(id)).catch(() => {});
  }
}

/** Delete a saved provider and its stored key; reselect the first remaining. */
export async function deleteSavedProvider(id: string): Promise<void> {
  const list = readProviders().filter((p) => p.id !== id);
  writeProviders(list);
  await SecureStore.deleteItemAsync(secureKeyFor(id)).catch(() => {});
  if (getActiveProviderId() === id) {
    setSetting(KEY_ACTIVE_PROVIDER, list[0]?.id ?? "");
  }
}

/** Mark a saved provider active. */
export function selectSavedProvider(id: string): void {
  setSetting(KEY_ACTIVE_PROVIDER, id);
}

/**
 * One-time migration: copy any AI config the user previously saved into the
 * active source's `app_settings` table over to the device-global meta DB. Runs
 * lazily on first access and is idempotent (guarded by a meta flag). Best-effort
 * — if no source is active yet or the table is empty, it just sets the flag.
 */
function migrateFromAppSettingsOnce(): void {
  if (getMeta(MIGRATION_FLAG) === "1") return;
  try {
    const db = getDb(); // active source DB; throws if no source selected
    for (const key of MIGRATED_KEYS) {
      // Don't clobber a value already in meta (e.g. set on a newer build).
      if (getMeta(key) !== null) continue;
      const row = db.getFirstSync<{ value: string }>(
        "SELECT value FROM app_settings WHERE key = ?",
        key,
      );
      if (row?.value != null) setMeta(key, row.value);
    }
    setMeta(MIGRATION_FLAG, "1");
  } catch {
    // No active source yet — leave unmigrated; we'll retry on the next access.
    // (Do NOT set the flag, so the migration still runs once a source exists.)
  }
}

function getSetting(key: string): string | null {
  migrateFromAppSettingsOnce();
  return getMeta(key);
}

function setSetting(key: string, value: string): void {
  // Ensure any legacy app_settings value is migrated before we start writing to
  // meta, so a partial write can't leave stale reads split across both stores.
  migrateFromAppSettingsOnce();
  setMeta(key, value);
}

/** The configured OpenAI-compatible base URL (or the default). Prefers the
 *  active saved provider, falling back to the legacy flat setting. */
export function getOpenAIBaseUrl(): string {
  const active = getActiveProvider();
  if (active) return active.baseUrl.trim() || DEFAULT_OPENAI_BASE_URL;
  return getSetting(KEY_BASE_URL)?.trim() || DEFAULT_OPENAI_BASE_URL;
}

/** The configured model id (or the default). Prefers the active saved provider. */
export function getOpenAIModel(): string {
  const active = getActiveProvider();
  if (active) return active.model.trim() || DEFAULT_OPENAI_MODEL;
  return getSetting(KEY_MODEL)?.trim() || DEFAULT_OPENAI_MODEL;
}

/** Optional manual context-window override (tokens), or undefined if unset/invalid. */
export function getOpenAIContextLimit(): number | undefined {
  const active = getActiveProvider();
  if (active) return active.contextLimit && active.contextLimit > 0 ? active.contextLimit : undefined;
  const raw = getSetting(KEY_CONTEXT)?.trim();
  if (!raw) return undefined;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * Persist the non-secret base URL + model + optional context override. When a
 * saved provider is active, the edit updates that provider; otherwise it writes
 * the legacy flat setting (kept for the no-providers fallback path).
 */
export function setOpenAIEndpoint(baseUrl: string, model: string, contextLimit?: number): void {
  const active = getActiveProvider();
  if (active) {
    const list = readProviders().map((p) =>
      p.id === active.id
        ? {
            ...p,
            baseUrl: baseUrl.trim() || DEFAULT_OPENAI_BASE_URL,
            model: model.trim() || DEFAULT_OPENAI_MODEL,
            contextLimit: contextLimit && contextLimit > 0 ? Math.floor(contextLimit) : undefined,
          }
        : p,
    );
    writeProviders(list);
    return;
  }
  setSetting(KEY_BASE_URL, baseUrl.trim());
  setSetting(KEY_MODEL, model.trim());
  setSetting(KEY_CONTEXT, contextLimit && contextLimit > 0 ? String(Math.floor(contextLimit)) : "");
}

/**
 * The user's preferred provider. If the user explicitly chose one, honour it.
 * Otherwise default to "rork" when a Rork endpoint was built in (first-party
 * builds are zero-config), else "openai". On-device Apple is never the implicit
 * default — the user opts into it — but it's always an available fallback.
 */
export function getProviderPref(rorkAvailable: boolean): ProviderPref {
  const stored = getSetting(KEY_PROVIDER);
  if (stored === "rork" || stored === "openai" || stored === "apple") return stored;
  return rorkAvailable ? "rork" : "openai";
}

/** Persist the preferred provider. */
export function setProviderPref(pref: ProviderPref): void {
  setSetting(KEY_PROVIDER, pref);
}

/** Default PCC reasoning effort when the user hasn't chosen one. */
export const DEFAULT_APPLE_REASONING: AppleReasoningLevel = "moderate";

/**
 * The user's chosen PCC reasoning level (Apple Intelligence via Private Cloud
 * Compute, iOS 27+). Deeper reasoning trades latency + context for stronger
 * multi-step analysis. Ignored on-device / by non-Apple providers.
 */
export function getAppleReasoningLevel(): AppleReasoningLevel {
  const v = getSetting(KEY_APPLE_REASONING);
  return v === "light" || v === "moderate" || v === "deep" ? v : DEFAULT_APPLE_REASONING;
}

/** Persist the PCC reasoning level. */
export function setAppleReasoningLevel(level: AppleReasoningLevel): void {
  setSetting(KEY_APPLE_REASONING, level);
}

/** Read the API key from the keychain (null if none stored). */
export async function getOpenAIApiKey(): Promise<string | null> {
  // Prefer the active saved provider's key; fall back to the legacy single key
  // (pre-migration / if no providers exist yet).
  const active = getActiveProvider();
  if (active) {
    const k = await getProviderApiKey(active.id);
    if (k != null) return k;
  }
  return getLegacyApiKey();
}

/** Read the legacy single API key (pre saved-providers). Used by migration. */
async function getLegacyApiKey(): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(SECURE_KEY_APIKEY);
  } catch {
    return null;
  }
}

/** Store (or clear, when empty) the API key in the keychain. */
export async function setOpenAIApiKey(apiKey: string): Promise<void> {
  const trimmed = apiKey.trim();
  // Route to the active provider's key when one exists, so edits made in the
  // legacy single-field UI still land on the selected provider.
  const active = getActiveProvider();
  if (active) {
    if (!trimmed) {
      await SecureStore.deleteItemAsync(secureKeyFor(active.id)).catch(() => {});
      return;
    }
    await SecureStore.setItemAsync(secureKeyFor(active.id), trimmed);
    return;
  }
  if (!trimmed) {
    await SecureStore.deleteItemAsync(SECURE_KEY_APIKEY).catch(() => {});
    return;
  }
  await SecureStore.setItemAsync(SECURE_KEY_APIKEY, trimmed);
}

/**
 * True when the user pointed at a custom (non-default) endpoint. Local
 * OpenAI-compatible servers (LM Studio, Ollama, …) need no API key, so a custom
 * base URL alone is enough to consider OpenAI configured.
 */
function hasCustomBaseUrl(): boolean {
  const active = getActiveProvider();
  const url = active ? active.baseUrl.trim() : getSetting(KEY_BASE_URL)?.trim();
  return !!url && url !== DEFAULT_OPENAI_BASE_URL;
}

/**
 * Resolve the full OpenAI config, or null if it can't run yet. Requires either
 * an API key (hosted providers) OR a custom base URL (keyless local servers).
 */
export async function resolveOpenAIConfig(): Promise<OpenAIConfig | null> {
  // Ensure the flat→providers migration has run so the active-provider getters
  // resolve correctly on first use after upgrade.
  await migrateToProvidersOnce();
  const apiKey = (await getOpenAIApiKey()) ?? "";
  if (!apiKey && !hasCustomBaseUrl()) return null;
  return {
    baseUrl: getOpenAIBaseUrl(),
    model: getOpenAIModel(),
    apiKey,
    contextLimit: getOpenAIContextLimit(),
  };
}

/** Whether the OpenAI provider is usable (has a key, or a custom keyless endpoint). */
export async function isOpenAIConfigured(): Promise<boolean> {
  await migrateToProvidersOnce();
  if (hasCustomBaseUrl()) return true;
  return (await getOpenAIApiKey()) != null;
}
