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
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientMetadata,
  OAuthClientInformationFull,
  OAuthClientInformationMixed,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import * as secrets from "./secure-store";
import { randomUUID } from "crypto";
import { startLoopbackListener, type LoopbackListener } from "./oauth-loopback";

/**
 * Default OAuth redirect target — the `cairn://` custom scheme, registered as an
 * OS protocol in main.ts. Used as a fallback; most providers (Canva, Google, …)
 * reject custom schemes at `/authorize` and require the loopback redirect
 * instead, so {@link startServerAuth} prefers loopback by default.
 */
export const OAUTH_REDIRECT_URI = "cairn://oauth/callback";
/** Custom protocol scheme Cairn registers for deep links. */
export const DEEP_LINK_SCHEME = "cairn";

/** Secret-store keys for the per-server OAuth artefacts. */
const KEY_CLIENT_INFO = "oauth_client";
const KEY_TOKENS = "oauth_tokens";
const KEY_VERIFIER = "oauth_verifier";

// ── Deep-link parsing (pure, unit-testable) ──────────────────────────────────

export interface OAuthCallback {
  code: string;
  state: string;
}

/**
 * Parse a `cairn://oauth/callback?code=…&state=…` deep link. Returns null if the
 * URL is not a well-formed OAuth callback (wrong scheme/host, missing params) so
 * unrelated deep links are ignored. Tolerant of host vs. path styles
 * (`cairn://oauth/callback` and `cairn:///oauth/callback`).
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
  const state = url.searchParams.get("state");
  if (!code || !state) return null;
  return { code, state };
}

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

  constructor(
    private readonly serverId: string,
    private readonly serverName: string,
    private readonly scope?: string,
    /** Inject a fixed state for deterministic callback routing; defaults random. */
    state?: string,
    /** Redirect URI to advertise (loopback or custom scheme). Defaults to cairn://. */
    redirectUri?: string,
  ) {
    this._state = state ?? randomUUID();
    this._redirectUri = redirectUri ?? OAUTH_REDIRECT_URI;
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
      secrets.getToolJson<OAuthClientInformationFull>("mcp", this.serverId, KEY_CLIENT_INFO) ??
      undefined
    );
  }

  saveClientInformation(info: OAuthClientInformationFull): void {
    secrets.setToolJson("mcp", this.serverId, KEY_CLIENT_INFO, info);
  }

  tokens(): OAuthTokens | undefined {
    return secrets.getToolJson<OAuthTokens>("mcp", this.serverId, KEY_TOKENS) ?? undefined;
  }

  saveTokens(tokens: OAuthTokens): void {
    secrets.setToolJson("mcp", this.serverId, KEY_TOKENS, tokens);
  }

  saveCodeVerifier(verifier: string): void {
    secrets.setToolJson("mcp", this.serverId, KEY_VERIFIER, verifier);
  }

  codeVerifier(): string {
    const v = secrets.getToolJson<string>("mcp", this.serverId, KEY_VERIFIER);
    if (!v) throw new Error("Missing PKCE code verifier — restart the sign-in flow.");
    return v;
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    // The authorize URL is always https; opens in the system browser.
    void shell.openExternal(authorizationUrl.toString());
  }

  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): void {
    if (scope === "all" || scope === "client") {
      secrets.deleteSecret("mcp", this.serverId, KEY_CLIENT_INFO);
    }
    if (scope === "all" || scope === "tokens") {
      secrets.deleteSecret("mcp", this.serverId, KEY_TOKENS);
    }
    if (scope === "all" || scope === "verifier") {
      secrets.deleteSecret("mcp", this.serverId, KEY_VERIFIER);
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
export function hasTokens(serverId: string): boolean {
  return secrets.getToolJson<OAuthTokens>("mcp", serverId, KEY_TOKENS) !== null;
}

/** Forget every OAuth artefact for a server (sign out). */
export function signOut(serverId: string): void {
  secrets.deleteSecret("mcp", serverId, KEY_CLIENT_INFO);
  secrets.deleteSecret("mcp", serverId, KEY_TOKENS);
  secrets.deleteSecret("mcp", serverId, KEY_VERIFIER);
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

  let listener: LoopbackListener | null = null;
  try {
    listener = await startLoopbackListener();
  } catch {
    // Loopback couldn't bind; fall back to the cairn:// deep-link flow.
    return startServerAuthDeepLink(cfg, serverName);
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

// Keep the registry from leaking across app lifetime.
app?.on?.("before-quit", () => {
  for (const [, p] of pending) void p.client.close().catch(() => {});
  pending.clear();
});
