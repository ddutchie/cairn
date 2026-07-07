/**
 * Provider auto-selection.
 *
 * Respects the user's provider preference (ai-config), then falls back:
 *   1. If pref is "apple" and the device supports on-device Apple Intelligence → Apple.
 *   2. If pref is "openai" and an OpenAI key is configured → OpenAI.
 *   3. Rork — if the build injected EXPO_PUBLIC_TOOLKIT_URL (first-party builds).
 *      Zero config for the user; the default preference when Rork is built in.
 *   4. OpenAI-compatible — if the user configured a base URL + API key in-app.
 *   5. On-device Apple — as a last-resort fallback whenever it's available
 *      (works offline, no key), even when it wasn't the explicit preference.
 *   6. Neither → throw NoProviderError so the UI can prompt the user to add a
 *      key in Settings (or enable Apple Intelligence).
 */

import { getProviderPref, resolveOpenAIConfig } from "../ai-config";
import { appleProvider, isAppleProviderAvailable } from "./apple";
import { makeOpenAIProvider } from "./openai";
import { isRorkAvailable, rorkProvider } from "./rork";
import type { ChatProvider } from "./types";

export * from "./types";

/** Thrown when no AI backend is configured (no Rork build URL, no OpenAI key). */
export class NoProviderError extends Error {
  constructor() {
    super(
      "No AI provider configured. Enable Apple Intelligence, or add an OpenAI-compatible base URL and API key in Settings.",
    );
    this.name = "NoProviderError";
  }
}

/**
 * Resolve the active provider. Honours the user's preference first (Apple when
 * on-device is available; OpenAI when configured), then Rork when built in, then
 * a configured OpenAI, then on-device Apple as a universal offline fallback,
 * else NoProviderError. Async because reading the API key touches the keychain.
 */
export async function resolveProvider(): Promise<ChatProvider> {
  const rork = isRorkAvailable();
  const apple = isAppleProviderAvailable();
  const pref = getProviderPref(rork);

  if (pref === "apple") {
    if (apple) return appleProvider;
    // Preferred Apple but unavailable (older OS / disabled) — fall through.
  } else if (pref === "openai") {
    const openai = await resolveOpenAIConfig();
    if (openai) return makeOpenAIProvider(openai);
    // Preferred OpenAI but not configured — fall back below.
  }

  // Fallback order: Rork → configured OpenAI → on-device Apple.
  if (rork) return rorkProvider;
  const openai = await resolveOpenAIConfig();
  if (openai) return makeOpenAIProvider(openai);
  if (apple) return appleProvider;
  throw new NoProviderError();
}

/** Whether any provider is usable right now (for gating the composer). */
export async function hasProvider(): Promise<boolean> {
  if (isRorkAvailable()) return true;
  if (isAppleProviderAvailable()) return true;
  return (await resolveOpenAIConfig()) != null;
}
