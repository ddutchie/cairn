/**
 * AI configuration store (local-only, on-device).
 *
 * Two backends, chosen by secrecy:
 *   - Non-secret config (OpenAI-compatible base URL + model) lives in the
 *     `app_settings` SQLite table — local-only, never synced.
 *   - The API key (a secret) lives in expo-secure-store (iOS keychain /
 *     Android keystore), never in SQLite and never synced.
 *
 * Provider selection (see providers/index.ts):
 *   - If the build injected a Rork toolkit URL (EXPO_PUBLIC_TOOLKIT_URL), the
 *     app uses Rork with zero config.
 *   - Otherwise it uses the OpenAI-compatible provider configured here. This is
 *     the path for third-party builders: bring your own endpoint + key, so the
 *     app never leans on our unauthenticated Rork endpoint.
 */

import * as SecureStore from "expo-secure-store";
import { getDb } from "../db";
import type { AppleReasoningLevel } from "@modules/apple-llm";

const KEY_BASE_URL = "ai.openai.baseUrl";
const KEY_MODEL = "ai.openai.model";
const KEY_CONTEXT = "ai.openai.contextLimit"; // optional manual override (tokens)
const KEY_PROVIDER = "ai.provider"; // "rork" | "openai" | "apple"
const KEY_APPLE_REASONING = "ai.apple.reasoningLevel"; // "light" | "moderate" | "deep"
const SECURE_KEY_APIKEY = "ai.openai.apiKey"; // secure-store key

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

function getSetting(key: string): string | null {
  const row = getDb().getFirstSync<{ value: string }>(
    "SELECT value FROM app_settings WHERE key = ?",
    key,
  );
  return row?.value ?? null;
}

function setSetting(key: string, value: string): void {
  getDb().runSync(
    "INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    key,
    value,
  );
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
