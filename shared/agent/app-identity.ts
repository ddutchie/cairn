/**
 * Cairn — portable app identity for provider attribution (pilot for the
 * desktop↔mobile fork consolidation, cleanup Phase 7).
 *
 * Pure portable core shared by `electron/lib/cairn-identity.ts` (desktop) and
 * `mobile/src/chat/cairn-identity.ts` (Expo): identity construction from an
 * explicit version string, the opencode-endpoint predicate, and the
 * `x-opencode-session` header builders. Version *resolution* (package.json via
 * Electron, expo-constants on mobile) and the desktop global-fetch wrapper stay
 * platform-side — this module has no platform imports and no side effects.
 */

export interface AppIdentity {
  product: "cairn";
  version: string;
  url: "https://github.com/ddutchie/cairn";
}

export function createAppIdentity(version: string): { userAgent: string; identity: AppIdentity } {
  return {
    userAgent: `cairn/${version}`,
    identity: { product: "cairn", version, url: "https://github.com/ddutchie/cairn" },
  };
}

/** True when the base URL targets the OpenCode Zen proxy (opencode.ai). */
export function isOpencodeEndpoint(baseUrl: string): boolean {
  return baseUrl.toLowerCase().includes("opencode.ai");
}

// ── Opencode session affinity ────────────────────────────────────────────
// Opencode's Zen proxy expects `x-opencode-session` (stable per conversation)
// for routing + prompt caching.

let currentOpencodeSessionId: string | null = null;

export function setCurrentOpencodeSessionId(id: string | null): void {
  currentOpencodeSessionId = id;
}

export function getCurrentOpencodeSessionId(): string | null {
  return currentOpencodeSessionId;
}

export function opencodeSessionHeaders(sessionId?: string | null): Record<string, string> {
  const id = sessionId ?? currentOpencodeSessionId;
  return id ? { "x-opencode-session": id } : {};
}

/** Build the full opencode-aware headers for a request (User-Agent + session). */
export function opencodeHeaders(
  userAgent: string,
  baseUrl: string,
  sessionId?: string | null,
): Record<string, string> {
  const headers: Record<string, string> = { "User-Agent": userAgent };
  if (isOpencodeEndpoint(baseUrl)) {
    const sess = opencodeSessionHeaders(sessionId);
    if (sess["x-opencode-session"]) headers["x-opencode-session"] = sess["x-opencode-session"];
  }
  return headers;
}
