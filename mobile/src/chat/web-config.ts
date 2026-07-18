/**
 * Web-search / web-extract configuration (local-only, on-device).
 *
 * Mirrors the split in ai-config.ts:
 *   - The chosen web provider (non-secret) lives in the DEVICE-GLOBAL meta DB
 *     (getMeta/setMeta) — local-only, never synced.
 *   - The API keys (secrets) live in expo-secure-store (iOS keychain / Android
 *     keystore), never in SQLite and never synced. Keys are stored per provider
 *     so a user can hold both a Tavily and a Brave key and switch between them.
 *
 * Two providers are supported for the `web_search` tool:
 *   - "tavily": LLM-optimised search + clean page extraction (search + extract).
 *   - "brave":  Brave Search web index (search only).
 *
 * The `web_extract` tool is Tavily-only — Brave has no page-extraction endpoint —
 * so extract falls back to a Tavily key when the active provider is Brave. See
 * web-tools.ts for how this is resolved at call time.
 */

import * as SecureStore from "expo-secure-store";
import { getMeta, setMeta } from "../db";

const KEY_PROVIDER = "web.provider"; // "tavily" | "brave"
const SECURE_KEY_TAVILY = "web.tavily.apiKey"; // secure-store key
const SECURE_KEY_BRAVE = "web.brave.apiKey"; // secure-store key

/** Which web backend the `web_search` tool uses. */
export type WebProvider = "tavily" | "brave";

/** Default web provider when the user hasn't chosen one. */
export const DEFAULT_WEB_PROVIDER: WebProvider = "tavily";

/** The user's chosen web provider (defaults to Tavily). */
export function getWebProvider(): WebProvider {
  const v = getMeta(KEY_PROVIDER);
  return v === "brave" || v === "tavily" ? v : DEFAULT_WEB_PROVIDER;
}

/** Persist the chosen web provider. */
export function setWebProvider(provider: WebProvider): void {
  setMeta(KEY_PROVIDER, provider);
}

async function readSecure(key: string): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(key);
  } catch {
    return null;
  }
}

async function writeSecure(key: string, value: string): Promise<void> {
  const trimmed = value.trim();
  if (!trimmed) {
    await SecureStore.deleteItemAsync(key).catch(() => {});
    return;
  }
  await SecureStore.setItemAsync(key, trimmed);
}

/** Read the Tavily API key from the keychain (null if none stored). */
export function getTavilyApiKey(): Promise<string | null> {
  return readSecure(SECURE_KEY_TAVILY);
}

/** Store (or clear, when empty) the Tavily API key in the keychain. */
export function setTavilyApiKey(apiKey: string): Promise<void> {
  return writeSecure(SECURE_KEY_TAVILY, apiKey);
}

/** Read the Brave API key from the keychain (null if none stored). */
export function getBraveApiKey(): Promise<string | null> {
  return readSecure(SECURE_KEY_BRAVE);
}

/** Store (or clear, when empty) the Brave API key in the keychain. */
export function setBraveApiKey(apiKey: string): Promise<void> {
  return writeSecure(SECURE_KEY_BRAVE, apiKey);
}

/** The API key for a given provider (null if unset). */
export function getWebApiKey(provider: WebProvider): Promise<string | null> {
  return provider === "brave" ? getBraveApiKey() : getTavilyApiKey();
}

/** Whether web search is usable — the active provider has a key stored. */
export async function isWebSearchConfigured(): Promise<boolean> {
  return (await getWebApiKey(getWebProvider())) != null;
}
