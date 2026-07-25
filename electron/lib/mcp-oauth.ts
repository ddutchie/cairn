/**
 * OAuth 2.1 for remote MCP servers.
 *
 * Some remote MCP servers (Canva, Figma, Linear, Notion, GitHub, …) gate access
 * behind an authorization page rather than a static API key. The MCP SDK
 * implements the full client side of the spec (authorization-server discovery,
 * dynamic client registration, PKCE, token exchange + refresh, retry-on-401);
 * we provide:
 *
 *   - {@link KeychainOAuthProvider} — an SDK `OAuthClientProvider` whose client
 *     registration, PKCE verifier, and tokens are persisted *encrypted* in the
 *     OS keychain via the secure store. Nothing OAuth-related is written to
 *     SQLite, and no token is ever exposed to the renderer.
 *   - A loopback redirect listener ({@link startServerAuth} uses
 *     `oauth-loopback.ts`) bound to `http://127.0.0.1:<port>/callback`. This is
 *     the default redirect because most authorization servers reject custom URI
 *     schemes at `/authorize` (Canva, Google, …).
 *   - A `cairn://oauth/callback` deep-link fallback (pending-authorization
 *     registry keyed by the OAuth `state`) for when the loopback listener can't
 *     bind or a provider prefers the custom scheme.
 *   - {@link startServerAuth} / {@link completeServerAuth} — the orchestration
 *     the IPC layer calls to begin a sign-in and to finish it from the callback.
 *
 * Main-process only. This module pulls in Electron `shell`/`app`.
 */

import { app, shell } from "electron";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { UnauthorizedError, auth } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { ToolKind } from "./secure-store";
import type {
  OAuthClientMetadata,
  OAuthClientInformationFull,
  OAuthClientInformationMixed,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import * as secrets from "./secure-store";
import { randomUUID } from "crypto";
import { startLoopbackListener, type LoopbackListener } from "./oauth-loopback";
// Deep-link callback parsing + the cairn:// constants now live in shared so
// desktop + mobile parse the redirect identically. Re-exported below for
// existing callers that import them from this module.
import {
  parseOAuthCallback,
  OAUTH_REDIRECT_URI,
  DEEP_LINK_SCHEME,
  type OAuthCallback,
} from "../../shared/chat/oauth-callback";

export { parseOAuthCallback, OAUTH_REDIRECT_URI, DEEP_LINK_SCHEME };
export type { OAuthCallback };

/**
 * Default OAuth redirect target — the `cairn://` custom scheme, registered as an
 * OS protocol in main.ts. Used as a fallback; most providers (Canva, Google, …)
 * reject custom schemes at `/authorize` and require the loopback redirect
 * instead, so {@link startServerAuth} prefers loopback by default.
 * (Definition + the deep-link parser now live in shared/chat/oauth-callback and
 * are re-exported at the top of this file.)
 */

/** Secret-store keys for the per-server OAuth artefacts. */
const KEY_CLIENT_INFO = "oauth_client";
const KEY_TOKENS = "oauth_tokens";
const KEY_VERIFIER = "oauth_verifier";

// ── Provider config ──────────────────────────────────────────────────────────

export interface OAuthServerConfig {
  id: string;
  baseUrl: string;
  transport: "http" | "sse";
  /** Optional requested scope. */
  scope?: string;
}

/**
 * SDK OAuth provider whose artefacts live in the OS keychain, namespaced by the
 * MCP server id. One instance per server; safe to construct on demand.
 */
export class KeychainOAuthProvider implements OAuthClientProvider {
  private _state: string;
  private _redirectUri: string;
  private readonly _toolType: ToolKind;

  constructor(
    private readonly serverId: string,
    private readonly serverName: string,
    private readonly scope?: string,
    /** Inject a fixed state for deterministic callback routing; defaults random. */
    state?: string,
    /** Redirect URI to advertise (loopback or custom scheme). Defaults to cairn://. */
    redirectUri?: string,
    /**
     * Keychain namespace the artefacts are stored under. Defaults to "mcp" so
     * existing MCP-server call sites are unchanged; custom HTTP services pass
     * "service" so their tokens can never collide with an MCP server of the
     * same id (mirrors the secretRef namespacing in secure-store).
     */
    toolType: ToolKind = "mcp",
  ) {
    this._state = state ?? randomUUID();
    this._redirectUri = redirectUri ?? OAUTH_REDIRECT_URI;
    this._toolType = toolType;
  }

  get redirectUrl(): string {
    return this._redirectUri;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: `Cairn — ${this.serverName}`,
      redirect_uris: [this._redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      ...(this.scope ? { scope: this.scope } : {}),
    };
  }

  /** Stable per-attempt state used to correlate the deep-link callback. */
  state(): string {
    return this._state;
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return (
      secrets.getToolJson<OAuthClientInformationFull>(this._toolType, this.serverId, KEY_CLIENT_INFO) ??
      undefined
    );
  }

  saveClientInformation(info: OAuthClientInformationFull): void {
    secrets.setToolJson(this._toolType, this.serverId, KEY_CLIENT_INFO, info);
  }

  tokens(): OAuthTokens | undefined {
    return secrets.getToolJson<OAuthTokens>(this._toolType, this.serverId, KEY_TOKENS) ?? undefined;
  }

  saveTokens(tokens: OAuthTokens): void {
    // Stamp an absolute expiry from the relative `expires_in` at write time, so
    // getAccessToken can later decide whether to refresh without knowing when the
    // token was issued. Purely additive — the SDK ignores unknown fields.
    const stamped =
      typeof tokens.expires_in === "number"
        ? { ...tokens, expires_at: Date.now() + tokens.expires_in * 1000 }
        : tokens;
    secrets.setToolJson(this._toolType, this.serverId, KEY_TOKENS, stamped);
  }

  saveCodeVerifier(verifier: string): void {
    secrets.setToolJson(this._toolType, this.serverId, KEY_VERIFIER, verifier);
  }

  codeVerifier(): string {
    const v = secrets.getToolJson<string>(this._toolType, this.serverId, KEY_VERIFIER);
    if (!v) throw new Error("Missing PKCE code verifier — restart the sign-in flow.");
    return v;
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    // The authorize URL is always https; opens in the system browser.
    void shell.openExternal(authorizationUrl.toString());
  }

  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): void {
    if (scope === "all" || scope === "client") {
      secrets.deleteSecret(this._toolType, this.serverId, KEY_CLIENT_INFO);
    }
    if (scope === "all" || scope === "tokens") {
      secrets.deleteSecret(this._toolType, this.serverId, KEY_TOKENS);
    }
    if (scope === "all" || scope === "verifier") {
      secrets.deleteSecret(this._toolType, this.serverId, KEY_VERIFIER);
    }
  }
}

// ── Transport factory (shared with mcp-client via getOAuthProvider) ──────────

/** True if this server should use the OAuth flow. */
export function isOAuthServer(cfg: { authMode?: "none" | "oauth" }): boolean {
  return cfg.authMode === "oauth";
}

/**
 * Build an OAuth provider for a server. A fresh `state` is generated unless one
 * is supplied (used when re-binding to a pending attempt is not needed — normal
 * connect/refresh paths don't need a stable state). `redirectUri` overrides the
 * advertised redirect (loopback URL for the interactive flow; defaults cairn://).
 */
export function makeProvider(
  cfg: OAuthServerConfig,
  serverName: string,
  state?: string,
  redirectUri?: string,
): KeychainOAuthProvider {
  return new KeychainOAuthProvider(cfg.id, serverName, cfg.scope, state, redirectUri);
}

function makeOAuthTransport(cfg: OAuthServerConfig, provider: OAuthClientProvider) {
  const url = new URL(cfg.baseUrl);
  if (cfg.transport === "sse") {
    return new SSEClientTransport(url, { authProvider: provider });
  }
  return new StreamableHTTPClientTransport(url, { authProvider: provider });
}

/** True if the server already has stored OAuth tokens (i.e. is "connected"). */
export function hasTokens(serverId: string, toolType: ToolKind = "mcp"): boolean {
  return secrets.getToolJson<OAuthTokens>(toolType, serverId, KEY_TOKENS) !== null;
}

/** Forget every OAuth artefact for a server (sign out). */
export function signOut(serverId: string, toolType: ToolKind = "mcp"): void {
  secrets.deleteSecret(toolType, serverId, KEY_CLIENT_INFO);
  secrets.deleteSecret(toolType, serverId, KEY_TOKENS);
  secrets.deleteSecret(toolType, serverId, KEY_VERIFIER);
}

// ── Pending-authorization registry ───────────────────────────────────────────

interface PendingAuth {
  serverId: string;
  provider: KeychainOAuthProvider;
  transport: StreamableHTTPClientTransport | SSEClientTransport;
  client: Client;
  createdAt: number;
}

/** state → in-flight attempt. */
const pending = new Map<string, PendingAuth>();
const PENDING_TTL_MS = 10 * 60_000;

// Loopback listeners awaiting a browser callback, keyed by server id, so an
// in-app "Cancel" can tear one down (closing the listener rejects its
// waitForCallback → the flow reports a cancelled sign-in to the renderer).
const activeLoopbacks = new Map<string, LoopbackListener>();

// Per-server generation counter. Bumped synchronously at the top of every
// startServerAuth so a newer invocation supersedes any older one still in its
// async setup: an older attempt whose generation is stale must abort (closing
// any listener it managed to bind) instead of registering listeners or leaving
// an orphaned loopback behind. Guards the concurrent-start race that the
// cancelServerAuth-at-entry call cannot cover, because two calls can both pass
// that point before either has registered anything in activeLoopbacks.
const authGeneration = new Map<string, number>();

function sweepPending(): void {
  const now = Date.now();
  for (const [state, p] of pending) {
    if (now - p.createdAt > PENDING_TTL_MS) {
      void p.client.close().catch(() => {});
      pending.delete(state);
    }
  }
}

export type AuthStartResult =
  | { status: "redirected" }
  | { status: "already_authorized" }
  | { status: "error"; error: string };

/** Notified when a loopback-completed sign-in finishes (success or failure). */
export type AuthCompletionListener = (result: AuthCompleteResult) => void;

/**
 * Begin an OAuth sign-in for a server. Prefers the RFC 8252 loopback redirect
 * (`http://127.0.0.1:<port>/callback`) because most authorization servers reject
 * custom URI schemes at `/authorize`; falls back to the `cairn://` deep link
 * only if the loopback listener cannot be started.
 *
 * Loopback path: a one-shot HTTP listener is started, the provider advertises
 * its URL as the redirect, and the SDK performs discovery + (if needed) dynamic
 * client registration. On the first connect the SDK either succeeds (valid
 * tokens already) or opens the browser and throws `UnauthorizedError`; we then
 * await the loopback callback, exchange the code, and invoke `onComplete`.
 *
 * @param onComplete  Called when a loopback flow finishes (the deep-link flow
 *   instead routes its completion through {@link completeServerAuth}). Lets the
 *   IPC layer forward the same `tools:oauthCallback` event for both paths.
 */
export async function startServerAuth(
  cfg: OAuthServerConfig,
  serverName: string,
  onComplete?: AuthCompletionListener,
): Promise<AuthStartResult> {
  sweepPending();
  // Drop any earlier in-flight attempt for this server before starting a new
  // one — including a prior loopback listener, so a re-initiated sign-in fully
  // supersedes the old flow (cancelServerAuth handles both loopback + deep-link).
  cancelServerAuth(cfg.id);

  // Claim a generation token synchronously, before any await. A concurrent
  // start for the same server bumps this again; the older attempt then sees its
  // token is stale after the async loopback bind and aborts (see isStale).
  const myGen = (authGeneration.get(cfg.id) ?? 0) + 1;
  authGeneration.set(cfg.id, myGen);
  const isStale = () => authGeneration.get(cfg.id) !== myGen;

  let listener: LoopbackListener | null = null;
  try {
    listener = await startLoopbackListener();
  } catch {
    // Loopback couldn't bind; fall back to the cairn:// deep-link flow.
    return startServerAuthDeepLink(cfg, serverName);
  }

  // A newer start superseded us while we were binding — abort and close our
  // listener so it doesn't leak (the newer attempt owns cfg.id now).
  if (isStale()) {
    listener.close();
    return { status: "error", error: "Superseded by a newer sign-in." };
  }

  // The loopback port changes every attempt, so a client registration saved with
  // a previous redirect URI no longer applies — clear it so DCR re-registers with
  // the current loopback URL. (Tokens are kept; they may still be valid.)
  secrets.deleteSecret("mcp", cfg.id, KEY_CLIENT_INFO);
  secrets.deleteSecret("mcp", cfg.id, KEY_VERIFIER);

  const provider = makeProvider(cfg, serverName, undefined, listener.redirectUri);
  const transport = makeOAuthTransport(cfg, provider);
  const client = new Client({ name: "cairn", version: "1.0.0" }, { capabilities: {} });

  try {
    await client.connect(transport);
    // Connected without a redirect → existing tokens were valid.
    listener.close();
    await client.close().catch(() => {});
    return { status: "already_authorized" };
  } catch (e) {
    if (!(e instanceof UnauthorizedError)) {
      listener.close();
      await client.close().catch(() => {});
      return { status: "error", error: e instanceof Error ? e.message : String(e) };
    }
  }

  // Browser opened. Await the loopback callback off the critical path, then
  // exchange the code and notify the caller. We return "redirected" immediately
  // so the UI can show a waiting state.
  if (isStale()) {
    listener.close();
    await client.close().catch(() => {});
    return { status: "error", error: "Superseded by a newer sign-in." };
  }
  activeLoopbacks.set(cfg.id, listener);
  void (async () => {
    try {
      const cb = await listener.waitForCallback;
      await transport.finishAuth(cb.code);
      await client.connect(transport).catch(() => {
        /* tokens already persisted; a flaky re-connect shouldn't fail sign-in */
      });
      await client.close().catch(() => {});
      onComplete?.({ status: "authorized", serverId: cfg.id });
    } catch (e) {
      await client.close().catch(() => {});
      onComplete?.({
        status: "error",
        serverId: cfg.id,
        error: e instanceof Error ? e.message : String(e),
      });
    } finally {
      // Only clear the map entry if it still points at OUR listener — a newer
      // sign-in for the same server may have replaced it, and we must not delete
      // (and thereby orphan) the newer flow's listener.
      if (activeLoopbacks.get(cfg.id) === listener) {
        activeLoopbacks.delete(cfg.id);
      }
    }
  })();

  return { status: "redirected" };
}

/**
 * Cancel an in-flight loopback sign-in for a server (the in-app "Cancel"
 * button). Closing the listener rejects its pending callback, which drives the
 * flow's catch → an `error` completion the renderer surfaces. Returns true if an
 * attempt was actually in flight.
 */
export function cancelServerAuth(serverId: string): boolean {
  const listener = activeLoopbacks.get(serverId);
  if (listener) {
    activeLoopbacks.delete(serverId);
    listener.close("Sign-in cancelled."); // rejects waitForCallback → completion listener fires "error"
  }
  // Also drop any deep-link pending attempt for the same server. Either path
  // counts as a real cancellation, so the IPC result reflects both.
  const deepLinkCancelled = cancelPendingForServer(serverId);
  return listener != null || deepLinkCancelled;
}

/**
 * Legacy `cairn://` deep-link sign-in path. Constructs an OAuth transport with
 * the custom-scheme redirect and stashes the attempt keyed by `state` for
 * {@link completeServerAuth} to resume from the deep link.
 */
async function startServerAuthDeepLink(
  cfg: OAuthServerConfig,
  serverName: string,
): Promise<AuthStartResult> {
  const provider = makeProvider(cfg, serverName);
  const transport = makeOAuthTransport(cfg, provider);
  const client = new Client({ name: "cairn", version: "1.0.0" }, { capabilities: {} });
  try {
    await client.connect(transport);
    await client.close().catch(() => {});
    return { status: "already_authorized" };
  } catch (e) {
    if (e instanceof UnauthorizedError) {
      pending.set(provider.state(), {
        serverId: cfg.id,
        provider,
        transport,
        client,
        createdAt: Date.now(),
      });
      return { status: "redirected" };
    }
    await client.close().catch(() => {});
    return { status: "error", error: e instanceof Error ? e.message : String(e) };
  }
}

export type AuthCompleteResult =
  | { status: "authorized"; serverId: string }
  | { status: "unknown_state" }
  | { status: "error"; serverId?: string; error: string };

/**
 * Complete an OAuth sign-in from a `cairn://oauth/callback` deep link. Looks up
 * the pending attempt by `state`, exchanges the authorization `code` for tokens
 * via `transport.finishAuth`, then verifies the connection. Tokens are persisted
 * by the provider's `saveTokens` during the exchange.
 */
export async function completeServerAuth(cb: OAuthCallback): Promise<AuthCompleteResult> {
  const p = pending.get(cb.state);
  if (!p) return { status: "unknown_state" };
  pending.delete(cb.state);
  try {
    await p.transport.finishAuth(cb.code);
    // Re-connect to confirm the tokens work and to settle the session.
    await p.client.connect(p.transport).catch(() => {
      /* finishAuth already persisted tokens; a flaky re-connect shouldn't fail sign-in */
    });
    await p.client.close().catch(() => {});
    return { status: "authorized", serverId: p.serverId };
  } catch (e) {
    await p.client.close().catch(() => {});
    return { status: "error", serverId: p.serverId, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Drop any pending attempt for a server (e.g. when its config changes). Returns
 * true if at least one pending deep-link attempt was removed. */
export function cancelPendingForServer(serverId: string): boolean {
  let removed = false;
  for (const [state, p] of pending) {
    if (p.serverId === serverId) {
      void p.client.close().catch(() => {});
      pending.delete(state);
      removed = true;
    }
  }
  return removed;
}

// ── HTTP-service OAuth (transport-independent) ───────────────────────────────
//
// Custom HTTP services authenticate with the SAME OAuth 2.1 machinery as MCP
// servers, but they have no MCP transport/session — a service call is a plain
// `fetch` with an `Authorization: Bearer` header. So instead of driving the flow
// through `transport.finishAuth`/`client.connect` (which speak MCP), we call the
// SDK's transport-agnostic `auth()` orchestrator directly. `auth()`:
//   - with no `authorizationCode`: runs discovery + (if needed) DCR, then either
//     returns "AUTHORIZED" (valid/refreshable tokens already stored) or opens the
//     browser via the provider's redirectToAuthorization and returns "REDIRECT".
//   - with an `authorizationCode`: exchanges the code (using the stored PKCE
//     verifier) for tokens and persists them via the provider's saveTokens.
// The provider's keychain storage is namespaced under toolType "service".

/** OAuth config for a custom HTTP service. */
export interface OAuthServiceConfig {
  id: string;
  /**
   * Resource/authorization-server base the SDK runs discovery against. For most
   * modern services this is the API's origin (e.g. https://api.example.com); the
   * `WWW-Authenticate`/RFC 9728 metadata points `auth()` at the real AS.
   */
  serverUrl: string;
  scope?: string;
}

/** Active loopback listeners for in-flight SERVICE sign-ins, keyed by service id. */
const activeServiceLoopbacks = new Map<string, LoopbackListener>();
/** Per-service generation counter guarding the concurrent-start race. */
const serviceAuthGeneration = new Map<string, number>();

/**
 * Begin an OAuth sign-in for a custom HTTP service. Mirrors {@link startServerAuth}
 * (loopback-first with the generation/cancellation guards) but never constructs
 * an MCP client — token exchange is driven entirely by the SDK `auth()` helper.
 *
 * @param onComplete Called when the loopback flow finishes (success or error),
 *   so the IPC layer can forward a `tools:oauthCallback` event.
 */
export async function startServiceAuth(
  cfg: OAuthServiceConfig,
  serviceName: string,
  onComplete?: AuthCompletionListener,
): Promise<AuthStartResult> {
  cancelServiceAuth(cfg.id);

  const myGen = (serviceAuthGeneration.get(cfg.id) ?? 0) + 1;
  serviceAuthGeneration.set(cfg.id, myGen);
  const isStale = () => serviceAuthGeneration.get(cfg.id) !== myGen;

  let listener: LoopbackListener;
  try {
    listener = await startLoopbackListener();
  } catch (e) {
    // Unlike MCP, services have no cairn:// deep-link fallback path yet (the
    // deep-link pending registry is tied to MCP transports), so a bind failure
    // is a hard error rather than a silent downgrade.
    return { status: "error", error: e instanceof Error ? e.message : String(e) };
  }

  if (isStale()) {
    listener.close();
    return { status: "error", error: "Superseded by a newer sign-in." };
  }

  // The loopback port changes each attempt, so a client registration saved with
  // a previous redirect URI no longer applies — clear it so DCR re-registers with
  // the current loopback URL. Tokens are kept (they may still be valid).
  secrets.deleteSecret("service", cfg.id, KEY_CLIENT_INFO);
  secrets.deleteSecret("service", cfg.id, KEY_VERIFIER);

  const provider = new KeychainOAuthProvider(
    cfg.id,
    serviceName,
    cfg.scope,
    undefined,
    listener.redirectUri,
    "service",
  );

  let result: Awaited<ReturnType<typeof auth>>;
  try {
    result = await auth(provider, { serverUrl: cfg.serverUrl, scope: cfg.scope });
  } catch (e) {
    listener.close();
    return { status: "error", error: e instanceof Error ? e.message : String(e) };
  }

  if (result === "AUTHORIZED") {
    // Stored tokens were still valid (or refreshed in place) — no browser needed.
    listener.close();
    return { status: "already_authorized" };
  }

  // "REDIRECT": the browser was opened. Await the loopback callback off the
  // critical path, exchange the code via auth(authorizationCode), then notify.
  if (isStale()) {
    listener.close();
    return { status: "error", error: "Superseded by a newer sign-in." };
  }
  activeServiceLoopbacks.set(cfg.id, listener);
  void (async () => {
    try {
      const cb = await listener.waitForCallback;
      const done = await auth(provider, {
        serverUrl: cfg.serverUrl,
        authorizationCode: cb.code,
        scope: cfg.scope,
      });
      if (done !== "AUTHORIZED") {
        throw new Error("Token exchange did not complete.");
      }
      onComplete?.({ status: "authorized", serverId: cfg.id });
    } catch (e) {
      onComplete?.({
        status: "error",
        serverId: cfg.id,
        error: e instanceof Error ? e.message : String(e),
      });
    } finally {
      if (activeServiceLoopbacks.get(cfg.id) === listener) {
        activeServiceLoopbacks.delete(cfg.id);
      }
    }
  })();

  return { status: "redirected" };
}

/**
 * Cancel an in-flight service sign-in (the in-app "Cancel" button). Closing the
 * listener rejects its pending callback → the flow's catch fires an `error`
 * completion. Returns true if an attempt was actually in flight.
 */
export function cancelServiceAuth(serviceId: string): boolean {
  const listener = activeServiceLoopbacks.get(serviceId);
  if (listener) {
    activeServiceLoopbacks.delete(serviceId);
    listener.close("Sign-in cancelled.");
    return true;
  }
  return false;
}

/**
 * Return a valid bearer access token for a service, refreshing it if expired.
 * Called by the custom-services executor per request. Returns null when the
 * service has never been authorized or a refresh fails (so the caller drops the
 * Authorization header rather than sending an expired/absent token).
 *
 * Refresh is delegated to the SDK `auth()` helper: with stored tokens present
 * and no authorizationCode, `auth()` uses the refresh_token grant when the
 * access token is expired and persists the rotated tokens via saveTokens. We
 * therefore proactively refresh when the stored token is at/near expiry, then
 * read the (possibly rotated) token back from the keychain.
 */
export async function getAccessToken(
  cfg: OAuthServiceConfig,
  serviceName: string,
): Promise<string | null> {
  const provider = new KeychainOAuthProvider(
    cfg.id,
    serviceName,
    cfg.scope,
    undefined,
    // Redirect URI is irrelevant for a non-interactive refresh; keep the default.
    undefined,
    "service",
  );

  const stored = provider.tokens();
  if (!stored?.access_token) return null; // never authorized

  if (!isTokenExpired(stored)) return stored.access_token;

  // Expired (or near-expiry) and we hold a refresh_token → let auth() run the
  // refresh grant. It won't open a browser: with tokens present it either
  // refreshes and returns "AUTHORIZED", or (refresh failed/absent) throws.
  if (!stored.refresh_token) return null;
  try {
    const result = await auth(provider, { serverUrl: cfg.serverUrl, scope: cfg.scope });
    if (result !== "AUTHORIZED") return null;
  } catch (e) {
    console.error(`[service-oauth] refresh failed for ${cfg.id}:`, e instanceof Error ? e.message : e);
    return null;
  }
  return provider.tokens()?.access_token ?? null;
}

/** True if the stored access token is expired or within the refresh skew window. */
function isTokenExpired(tokens: OAuthTokens): boolean {
  // Expiry is read from the absolute `expires_at` timestamp that stampExpiry
  // records on save (derived from expires_in at issue time). We refresh eagerly,
  // treating the token as expired once we're within TOKEN_REFRESH_SKEW_MS of it.
  const expiresAt = (tokens as OAuthTokens & { expires_at?: number }).expires_at;
  if (typeof expiresAt !== "number") {
    // No absolute expiry recorded → cannot prove expiry; assume still valid.
    // (New tokens are stamped with expires_at by stampExpiry on save.)
    return false;
  }
  return Date.now() >= expiresAt - TOKEN_REFRESH_SKEW_MS;
}

/** Refresh a little before the real expiry to avoid racing a 401 mid-request. */
const TOKEN_REFRESH_SKEW_MS = 60_000;

// Keep the registry from leaking across app lifetime.
app?.on?.("before-quit", () => {
  for (const [, p] of pending) void p.client.close().catch(() => {});
  pending.clear();
});
