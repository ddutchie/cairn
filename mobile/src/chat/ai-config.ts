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
const SECURE_KEY_APIKEY = "ai.openai.apiKey"; // secure-store key

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

/** The configured OpenAI-compatible base URL (or the default). */
export function getOpenAIBaseUrl(): string {
  return getSetting(KEY_BASE_URL)?.trim() || DEFAULT_OPENAI_BASE_URL;
}

/** The configured model id (or the default). */
export function getOpenAIModel(): string {
  return getSetting(KEY_MODEL)?.trim() || DEFAULT_OPENAI_MODEL;
}

/** Optional manual context-window override (tokens), or undefined if unset/invalid. */
export function getOpenAIContextLimit(): number | undefined {
  const raw = getSetting(KEY_CONTEXT)?.trim();
  if (!raw) return undefined;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Persist the non-secret base URL + model + optional context override. */
export function setOpenAIEndpoint(baseUrl: string, model: string, contextLimit?: number): void {
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
  try {
    return await SecureStore.getItemAsync(SECURE_KEY_APIKEY);
  } catch {
    return null;
  }
}

/** Store (or clear, when empty) the API key in the keychain. */
export async function setOpenAIApiKey(apiKey: string): Promise<void> {
  const trimmed = apiKey.trim();
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
  const url = getSetting(KEY_BASE_URL)?.trim();
  return !!url && url !== DEFAULT_OPENAI_BASE_URL;
}

/**
 * Resolve the full OpenAI config, or null if it can't run yet. Requires either
 * an API key (hosted providers) OR a custom base URL (keyless local servers).
 */
export async function resolveOpenAIConfig(): Promise<OpenAIConfig | null> {
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
  if (hasCustomBaseUrl()) return true;
  return (await getOpenAIApiKey()) != null;
}
