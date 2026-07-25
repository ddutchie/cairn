/**
 * OAuth deep-link callback parsing — shared by desktop (electron/lib/mcp-oauth)
 * and mobile (mobile/src/chat/mcp-oauth) so both parse the `cairn://oauth/
 * callback?code=…&state=…` redirect IDENTICALLY. Pure + framework-free.
 *
 * Mobile reuses the SAME cairn:// scheme desktop registers (declared in
 * mobile/app.json), so this one parser serves both platforms.
 */

/** Custom protocol scheme Cairn registers for deep links. */
export const DEEP_LINK_SCHEME = "cairn";

/** The redirect target advertised to authorization servers on the deep-link path. */
export const OAUTH_REDIRECT_URI = "cairn://oauth/callback";

export interface OAuthCallback {
  code: string;
  /**
   * The OAuth `state` echoed back, or "" when the authorization request didn't
   * include one. State is OPTIONAL in OAuth 2.1 and the MCP SDK's auth() flow
   * doesn't always send it (observed: Tavily returns `state=` empty), so a
   * missing/empty state must NOT invalidate an otherwise-valid callback — the
   * `code` is what the token exchange needs. Callers that DO use state to
   * correlate a pending attempt (desktop's deep-link registry) should treat ""
   * as "no state" rather than assume it's present.
   */
  state: string;
}

/**
 * Parse a `cairn://oauth/callback?code=…[&state=…]` deep link. Returns null only
 * when the URL isn't a well-formed callback (wrong scheme/host/path, or missing
 * the `code`) so unrelated deep links are ignored. `state` is optional (see
 * OAuthCallback). Tolerant of host vs. path styles (`cairn://oauth/callback` and
 * `cairn:///oauth/callback`).
 */
export function parseOAuthCallback(rawUrl: string): OAuthCallback | null {
  if (typeof rawUrl !== "string" || !rawUrl.startsWith(`${DEEP_LINK_SCHEME}://`)) return null;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  // Accept only the two documented forms, exactly:
  //   cairn://oauth/callback   → host="oauth"  pathname="/callback"   → "oauth/callback"
  //   cairn:///oauth/callback  → host=""       pathname="/oauth/callback" → "/oauth/callback"
  // Reject any deeper route that merely ends with oauth/callback.
  const path = `${url.host}${url.pathname}`.replace(/\/+$/, "");
  if (path !== "oauth/callback" && path !== "/oauth/callback") return null;
  const code = url.searchParams.get("code");
  if (!code) return null; // code is the only truly-required param
  return { code, state: url.searchParams.get("state") ?? "" };
}
