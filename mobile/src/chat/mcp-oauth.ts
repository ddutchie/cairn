/**
 * MCP OAuth 2.1 for mobile — the device-side counterpart to desktop's
 * electron/lib/mcp-oauth.ts.
 *
 * Same machinery (the MCP SDK drives discovery, dynamic client registration,
 * PKCE, token exchange + refresh via its transport-agnostic `auth()`), but the
 * two platform-specific pieces differ:
 *
 *   - STORAGE: OAuth artefacts (client registration, PKCE verifier, tokens) live
 *     in expo-secure-store (iOS keychain / Android keystore), namespaced by
 *     server id — never in SQLite, never synced. Mirrors desktop's
 *     KeychainOAuthProvider, but the getters are async (secure-store is async),
 *     which the SDK's OAuthClientProvider interface allows.
 *   - REDIRECT: desktop uses an RFC 8252 loopback listener; mobile CANNOT bind a
 *     local HTTP server, so it uses the `cairn://oauth/callback` deep link
 *     exclusively, opened via expo-web-browser `openAuthSessionAsync`, which
 *     returns the captured callback URL directly (no separate listener/registry
 *     needed). The cairn:// scheme is already declared in mobile/app.json.
 *
 * PKCE hashing uses globalThis.crypto (shimmed by crypto-polyfill.ts).
 */

import * as SecureStore from "expo-secure-store";
import * as WebBrowser from "expo-web-browser";
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientMetadata,
  OAuthClientInformationFull,
  OAuthClientInformationMixed,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { OAUTH_REDIRECT_URI, parseOAuthCallback } from "@cairn/shared/chat/oauth-callback";

/**
 * The https redirect we ADVERTISE to authorization servers. Strict providers
 * (Canva) reject a custom-scheme (cairn://) redirect_uri at /authorize, so we
 * register an https bounce page instead. That page (static, on gerardbuilds.com)
 * forwards the ?code&state straight to OAUTH_REDIRECT_URI (cairn://oauth/callback),
 * which the in-app auth session intercepts. This URL is also listed in the CIMD
 * doc's redirect_uris. See appsbygerard/cairn/oauth/index.html.
 */
const HTTPS_REDIRECT_URI = "https://gerardbuilds.com/cairn/oauth";

// Per-server secure-store keys (mirror desktop's KEY_* artefacts).
const KEY_CLIENT_INFO = "oauth_client";
const KEY_TOKENS = "oauth_tokens";
const KEY_VERIFIER = "oauth_verifier";

/** Refresh a little before the real expiry to avoid racing a 401 mid-request. */
const TOKEN_REFRESH_SKEW_MS = 60_000;

/**
 * CIMD (Client ID Metadata Document, SEP-991) — a static JSON file hosted on our
 * own https domain that describes Cairn as an OAuth client. Its URL IS the
 * client_id. When an MCP server advertises `client_id_metadata_document_supported`
 * the SDK uses this URL and SKIPS Dynamic Client Registration entirely.
 *
 * This is what lets CIMD-capable providers (e.g. Tavily) authenticate without
 * DCR. The redirect is validated against the `redirect_uris` list INSIDE this
 * trusted https document. NOTE: some providers advertise CIMD but their endpoint
 * is broken (Canva's CIMD /authorize 500s), so startAuth falls back to DCR per
 * server. Both modes use the https bounce redirect (see HTTPS_REDIRECT_URI),
 * which forwards to cairn://oauth/callback.
 *
 * The file lists the https bounce URL + cairn://oauth/callback in redirect_uris
 * and sets token_endpoint_auth_method:"none" (Cairn is a public/PKCE client).
 *   https://gerardbuilds.com/cairn/oauth-client.json  (repo: appsbygerard/cairn/)
 */
const CLIENT_METADATA_URL = "https://gerardbuilds.com/cairn/oauth-client.json";

/** OAuth config for an MCP server (subset of the stored server config). */
export interface OAuthServerConfig {
  id: string;
  /** The MCP server URL the SDK runs discovery against. */
  serverUrl: string;
  scope?: string;
}

/** Tokens carry an absolute expiry we stamp on save (SDK ignores unknown fields). */
type StampedTokens = OAuthTokens & { expires_at?: number };

const secureKey = (serverId: string, key: string) => `mcp.${serverId}.${key}`;

async function getJson<T>(serverId: string, key: string): Promise<T | undefined> {
  try {
    const raw = await SecureStore.getItemAsync(secureKey(serverId, key));
    return raw ? (JSON.parse(raw) as T) : undefined;
  } catch {
    return undefined;
  }
}

async function setJson(serverId: string, key: string, value: unknown): Promise<void> {
  await SecureStore.setItemAsync(secureKey(serverId, key), JSON.stringify(value));
}

async function del(serverId: string, key: string): Promise<void> {
  await SecureStore.deleteItemAsync(secureKey(serverId, key)).catch(() => {});
}

/**
 * SDK OAuth provider backed by expo-secure-store. One instance per server.
 *
 * `redirectToAuthorization` is intentionally a no-op that STASHES the URL: the
 * mobile flow drives the browser imperatively via `openAuthSessionAsync` (which
 * both opens the page and returns the callback), so we don't need the SDK to
 * open anything — we just need the authorize URL it built. `startAuth` reads it
 * back off the provider.
 */
export class SecureStoreOAuthProvider implements OAuthClientProvider {
  /** Authorize URL captured from the SDK's redirectToAuthorization call. */
  authorizationUrl: URL | null = null;

  /**
   * CIMD client_id URL (SEP-991). The SDK uses this URL as the client_id —
   * skipping Dynamic Client Registration — when the server advertises
   * client_id_metadata_document_supported. Servers that don't support CIMD fall
   * back to DCR via the SDK automatically.
   */
  readonly clientMetadataUrl = CLIENT_METADATA_URL;

  constructor(
    private readonly serverId: string,
    private readonly serverName: string,
    private readonly scope?: string,
  ) {}

  get redirectUrl(): string {
    // Advertise the https bounce page (strict providers reject cairn:// here).
    return HTTPS_REDIRECT_URI;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: `Cairn — ${this.serverName}`,
      // Advertise the https bounce redirect (used by DCR fallback + must match
      // the CIMD doc). The bounce page forwards to cairn://oauth/callback.
      redirect_uris: [HTTPS_REDIRECT_URI],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      ...(this.scope ? { scope: this.scope } : {}),
    };
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    return getJson<OAuthClientInformationFull>(this.serverId, KEY_CLIENT_INFO);
  }

  async saveClientInformation(info: OAuthClientInformationFull): Promise<void> {
    await setJson(this.serverId, KEY_CLIENT_INFO, info);
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    return getJson<OAuthTokens>(this.serverId, KEY_TOKENS);
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    // Stamp an absolute expiry from the relative expires_in at write time, so
    // getAccessToken can decide whether to refresh later. Additive; SDK ignores it.
    const stamped: StampedTokens =
      typeof tokens.expires_in === "number"
        ? { ...tokens, expires_at: Date.now() + tokens.expires_in * 1000 }
        : tokens;
    await setJson(this.serverId, KEY_TOKENS, stamped);
  }

  async saveCodeVerifier(verifier: string): Promise<void> {
    await setJson(this.serverId, KEY_VERIFIER, verifier);
  }

  async codeVerifier(): Promise<string> {
    const v = await getJson<string>(this.serverId, KEY_VERIFIER);
    if (!v) throw new Error("Missing PKCE code verifier — restart the sign-in flow.");
    return v;
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    // Capture (don't open) — the imperative flow opens it via WebBrowser.
    this.authorizationUrl = authorizationUrl;
  }

  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): void {
    if (scope === "all" || scope === "client") void del(this.serverId, KEY_CLIENT_INFO);
    if (scope === "all" || scope === "tokens") void del(this.serverId, KEY_TOKENS);
    if (scope === "all" || scope === "verifier") void del(this.serverId, KEY_VERIFIER);
  }
}

export type AuthStartResult =
  | { status: "authorized" }
  | { status: "cancelled" }
  // `desktopOnly` marks a failure caused by the provider refusing our mobile
  // redirect at registration (it only allows a loopback/pre-registered client,
  // e.g. Asana, Vercel) — the UI phrases these as "connect on desktop" rather
  // than a scary raw error.
  | { status: "error"; error: string; desktopOnly?: boolean };

/**
 * Translate a raw SDK/OAuth error into a friendly message. Detects the
 * "provider won't accept our mobile redirect / register" class (Asana-style
 * invalid_redirect_uri, registration 4xx) and flags it desktopOnly so the caller
 * can suggest desktop sign-in. Everything else gets a clean generic message
 * (the raw SDK text is often a JSON-parse error on the provider's non-JSON body).
 */
function friendlyAuthError(serverName: string, raw: string): { error: string; desktopOnly: boolean } {
  const r = raw.toLowerCase();
  const looksDesktopOnly =
    r.includes("invalid_redirect_uri") ||
    r.includes("redirect uri") ||
    r.includes("redirect_uri") ||
    r.includes("/register") || // registration was rejected (non-JSON 400 etc.)
    r.includes("registration");
  if (looksDesktopOnly) {
    return {
      error: `${serverName} doesn't allow sign-in from a phone — it only accepts a desktop connection. Connect it in the Cairn desktop app instead.`,
      desktopOnly: true,
    };
  }
  return {
    error: `Couldn't connect ${serverName}. Please try again, or connect it in the Cairn desktop app.`,
    desktopOnly: false,
  };
}

/**
 * Begin (and complete) an interactive OAuth sign-in for an MCP server via CIMD.
 *
 * We use CIMD (URL-based client_id, no registration) with an https bounce
 * redirect. This works for CIMD-capable providers whose redirect allowlist
 * accepts our https bounce URL (e.g. Tavily). Providers that require pre-
 * registration / an allow-listed redirect (e.g. Canva) can't be connected from
 * mobile without a registered app and are treated as desktop-only — the Tools
 * screen notes this. (We deliberately DON'T fall back to DCR: for those
 * providers DCR still fails the redirect allowlist, so a fallback just adds a
 * confusing second browser round-trip that also fails.)
 *
 * Flow: auth(serverUrl) → capture authorize URL → openAuthSessionAsync (server
 * redirects to our https bounce page → forwards to cairn://oauth/callback,
 * intercepted by the auth session) → parse the code → auth(authorizationCode)
 * exchanges it and persists tokens.
 *
 * Never throws — returns a status the UI can show.
 */
export async function startAuth(cfg: OAuthServerConfig, serverName: string): Promise<AuthStartResult> {
  const provider = new SecureStoreOAuthProvider(cfg.id, serverName, cfg.scope);

  // Clear stale client registration + verifier (awaited) so auth()'s
  // clientInformation() read starts fresh and the CIMD branch runs.
  await del(cfg.id, KEY_CLIENT_INFO);
  await del(cfg.id, KEY_VERIFIER);

  let step1: Awaited<ReturnType<typeof auth>>;
  try {
    step1 = await auth(provider, { serverUrl: cfg.serverUrl, scope: cfg.scope });
  } catch (e) {
    // Most commonly the provider rejecting our mobile redirect at registration
    // (Asana/Vercel loopback-only). Surface a human message + desktopOnly flag.
    return { status: "error", ...friendlyAuthError(serverName, e instanceof Error ? e.message : String(e)) };
  }
  if (step1 === "AUTHORIZED") return { status: "authorized" };

  const authUrl = provider.authorizationUrl;
  if (!authUrl) return { status: "error", error: "No authorization URL was produced." };

  let result: WebBrowser.WebBrowserAuthSessionResult;
  try {
    // Watch for the FINAL cairn:// scheme: the server redirects to our https
    // bounce page, which forwards to cairn://oauth/callback — the in-app auth
    // session intercepts that scheme and hands the code back.
    result = await WebBrowser.openAuthSessionAsync(authUrl.toString(), OAUTH_REDIRECT_URI);
  } catch (e) {
    return { status: "error", error: e instanceof Error ? e.message : String(e) };
  }
  if (result.type !== "success" || !("url" in result)) {
    // "cancel"/"dismiss" — user backed out, OR the provider rejected the redirect
    // / showed an in-page error (e.g. Canva's allowlist) and never redirected.
    return { status: "cancelled" };
  }

  const cb = parseOAuthCallback(result.url);
  if (!cb) return { status: "error", error: "The sign-in redirect was malformed (no authorization code)." };

  try {
    const done = await auth(provider, {
      serverUrl: cfg.serverUrl,
      authorizationCode: cb.code,
      scope: cfg.scope,
    });
    if (done !== "AUTHORIZED") return { status: "error", error: `Couldn't finish signing in to ${serverName}. Please try again.` };
    return { status: "authorized" };
  } catch (e) {
    return { status: "error", ...friendlyAuthError(serverName, e instanceof Error ? e.message : String(e)) };
  }
}

/** True if the server has stored tokens (i.e. has been connected). */
export async function hasTokens(serverId: string): Promise<boolean> {
  return (await getJson<OAuthTokens>(serverId, KEY_TOKENS)) != null;
}

/** Forget every OAuth artefact for a server (sign out). */
export async function signOut(serverId: string): Promise<void> {
  await del(serverId, KEY_CLIENT_INFO);
  await del(serverId, KEY_TOKENS);
  await del(serverId, KEY_VERIFIER);
}

/** True if the stored access token is expired or within the refresh skew window. */
function isTokenExpired(tokens: StampedTokens): boolean {
  const expiresAt = tokens.expires_at;
  if (typeof expiresAt !== "number") return false; // no absolute expiry → assume valid
  return Date.now() >= expiresAt - TOKEN_REFRESH_SKEW_MS;
}

/**
 * Return a valid bearer access token for a server, refreshing it via the SDK
 * `auth()` refresh grant if expired. Returns null when never authorized or a
 * refresh fails (so the transport connects without an Authorization header and
 * the caller can surface a re-auth prompt). Non-interactive: never opens a
 * browser.
 */
export async function getAccessToken(cfg: OAuthServerConfig, serverName: string): Promise<string | null> {
  const provider = new SecureStoreOAuthProvider(cfg.id, serverName, cfg.scope);
  const stored = (await provider.tokens()) as StampedTokens | undefined;
  if (!stored?.access_token) return null;
  if (!isTokenExpired(stored)) return stored.access_token;
  if (!stored.refresh_token) return null;
  try {
    const result = await auth(provider, { serverUrl: cfg.serverUrl, scope: cfg.scope });
    if (result !== "AUTHORIZED") return null;
  } catch {
    return null;
  }
  return (await provider.tokens())?.access_token ?? null;
}
