/**
 * Cairn — mobile app identity for provider attribution.
 *
 * Portable core (UA construction, endpoint predicate) delegates to
 * `@cairn/shared` (`shared/agent/app-identity.ts`, shared with desktop);
 * version resolution stays here (expo-constants). Kept in `src/chat` so
 * providers can import without pulling in Node-only code.
 */

import Constants from "expo-constants";
import { createAppIdentity, isOpencodeEndpoint } from "@cairn/shared/agent/app-identity";

export { isOpencodeEndpoint };

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

const { userAgent: CAIRN_USER_AGENT, identity: CAIRN_APP_IDENTITY } = createAppIdentity(getCairnVersion());

export { CAIRN_USER_AGENT, CAIRN_APP_IDENTITY };
