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

const KEY_BASE_URL = "ai.openai.baseUrl";
const KEY_MODEL = "ai.openai.model";
const KEY_PROVIDER = "ai.provider"; // "rork" | "openai"
const SECURE_KEY_APIKEY = "ai.openai.apiKey"; // secure-store key

/** Which backend the user prefers when more than one is available. */
export type ProviderPref = "rork" | "openai";

/** Sensible default for an OpenAI-compatible endpoint. */
export const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
export const DEFAULT_OPENAI_MODEL = "gpt-4.1-mini";

export interface OpenAIConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
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

/** Persist the non-secret base URL + model. Empty values reset to defaults. */
export function setOpenAIEndpoint(baseUrl: string, model: string): void {
  setSetting(KEY_BASE_URL, baseUrl.trim());
  setSetting(KEY_MODEL, model.trim());
}

/**
 * The user's preferred provider. Defaults to "rork" when a Rork endpoint was
 * built in (so first-party builds are zero-config), otherwise "openai".
 */
export function getProviderPref(rorkAvailable: boolean): ProviderPref {
  const stored = getSetting(KEY_PROVIDER);
  if (stored === "rork" || stored === "openai") return stored;
  return rorkAvailable ? "rork" : "openai";
}

/** Persist the preferred provider. */
export function setProviderPref(pref: ProviderPref): void {
  setSetting(KEY_PROVIDER, pref);
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
 * Resolve the full OpenAI config, or null if no API key has been set yet (in
 * which case chat can't run on the OpenAI provider and the UI should prompt the
 * user to configure it).
 */
export async function resolveOpenAIConfig(): Promise<OpenAIConfig | null> {
  const apiKey = await getOpenAIApiKey();
  if (!apiKey) return null;
  return { baseUrl: getOpenAIBaseUrl(), model: getOpenAIModel(), apiKey };
}

/** Whether the OpenAI provider is usable (has a key). */
export async function isOpenAIConfigured(): Promise<boolean> {
  return (await getOpenAIApiKey()) != null;
}
