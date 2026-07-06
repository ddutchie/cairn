/**
 * Provider auto-selection.
 *
 * Priority:
 *   1. Rork — if the build injected EXPO_PUBLIC_TOOLKIT_URL (first-party builds).
 *      Zero config for the user.
 *   2. OpenAI-compatible — if the user configured a base URL + API key in-app
 *      (ai-config). The path for third-party builders / BYO key.
 *   3. Neither → throw NoProviderError so the UI can prompt the user to add a
 *      key in Settings.
 */

import { resolveOpenAIConfig } from "../ai-config";
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
 * Resolve the active provider. Rork wins when its build-time URL is present;
 * otherwise we use the user's OpenAI-compatible config. Async because reading
 * the API key touches the keychain.
 */
export async function resolveProvider(): Promise<ChatProvider> {
  if (isRorkAvailable()) return rorkProvider;
  const openai = await resolveOpenAIConfig();
  if (openai) return makeOpenAIProvider(openai);
  throw new NoProviderError();
}

/** Whether any provider is usable right now (for gating the composer). */
export async function hasProvider(): Promise<boolean> {
  if (isRorkAvailable()) return true;
  return (await resolveOpenAIConfig()) != null;
}
