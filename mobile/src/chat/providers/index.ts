/**
 * Provider auto-selection.
 *
 * Respects the user's provider preference (ai-config), then falls back:
 *   1. If pref is "openai" and an OpenAI key is configured → OpenAI.
 *   2. Rork — if the build injected EXPO_PUBLIC_TOOLKIT_URL (first-party builds).
 *      Zero config for the user; the default preference when Rork is built in.
 *   3. OpenAI-compatible — if the user configured a base URL + API key in-app.
 *   4. Neither → throw NoProviderError so the UI can prompt the user to add a
 *      key in Settings.
 */

import { getProviderPref, resolveOpenAIConfig } from "../ai-config";
import { makeOpenAIProvider } from "./openai";
import { isRorkAvailable, rorkProvider } from "./rork";
import type { ChatProvider } from "./types";

export * from "./types";

/** Thrown when no AI backend is configured (no Rork build URL, no OpenAI key). */
export class NoProviderError extends Error {
  constructor() {
    super(
      "No AI provider configured. Add an OpenAI-compatible base URL and API key in Settings.",
    );
    this.name = "NoProviderError";
  }
}

/**
 * Resolve the active provider. Honours the user's preference: if they chose
 * OpenAI (and it's configured) we use it even when Rork is built in; otherwise
 * Rork wins when available, then a configured OpenAI, else NoProviderError.
 * Async because reading the API key touches the keychain.
 */
export async function resolveProvider(): Promise<ChatProvider> {
  const rork = isRorkAvailable();
  const pref = getProviderPref(rork);

  if (pref === "openai") {
    const openai = await resolveOpenAIConfig();
    if (openai) return makeOpenAIProvider(openai);
    // Preferred OpenAI but not configured — fall back to Rork if we can.
    if (rork) return rorkProvider;
    throw new NoProviderError();
  }

  // pref === "rork"
  if (rork) return rorkProvider;
  const openai = await resolveOpenAIConfig();
  if (openai) return makeOpenAIProvider(openai);
  throw new NoProviderError();
}

/** Whether any provider is usable right now (for gating the composer). */
export async function hasProvider(): Promise<boolean> {
  if (isRorkAvailable()) return true;
  return (await resolveOpenAIConfig()) != null;
}
