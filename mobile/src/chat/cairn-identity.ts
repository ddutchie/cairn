/**
 * Cairn — mobile app identity for provider attribution (mirrors
 * `electron/lib/cairn-identity.ts` on desktop). Kept in `src/chat` so
 * providers can import without pulling in Node-only `fs`/`electron` code.
 */

import Constants from "expo-constants";

function getCairnVersion(): string {
  // expo-constants is the runtime source of truth for the installed binary's
  // version (app.json `expo.version`). Fall back to the hard-coded version
  // from app.json so the header is never blank in tests / bare JS.
  try {
    const v =
      (Constants as unknown as { expoConfig?: { version?: string } })?.expoConfig?.version ??
      (Constants as unknown as { manifest?: { version?: string } })?.manifest?.version;
    if (v) return v;
  } catch {
    // ignore — fall through
  }
  return "0.1.7";
}

const version = getCairnVersion();

export const CAIRN_USER_AGENT = `cairn/${version}`;

export const CAIRN_APP_IDENTITY = {
  product: "cairn",
  version,
  url: "https://github.com/ddutchie/cairn",
} as const;

export function isOpencodeEndpoint(baseUrl: string): boolean {
  return baseUrl.toLowerCase().includes("opencode.ai");
}
