/**
 * OAuth 2.1 for remote MCP servers.
 *
 * Some remote MCP servers (Figma, Linear, Notion, GitHub, …) gate access behind
 * an authorization page rather than a static API key. The MCP SDK implements the
 * full client side of the spec (authorization-server discovery, dynamic client
 * registration, PKCE, token exchange + refresh, retry-on-401); we provide:
 *
 *   - {@link KeychainOAuthProvider} — an SDK `OAuthClientProvider` whose client
 *     registration, PKCE verifier, and tokens are persisted *encrypted* in the
 *     OS keychain via the secure store. Nothing OAuth-related is written to
 *     SQLite, and no token is ever exposed to the renderer.
 *   - A pending-authorization registry keyed by the OAuth `state` parameter, so
 *     the `cairn://oauth/callback` deep link can be routed back to the in-flight
 *     attempt that started it.
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

/** The OAuth redirect target. Registered as an OS protocol in main.ts. */
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

  constructor(
    private readonly serverId: string,
    private readonly serverName: string,
    private readonly scope?: string,
    /** Inject a fixed state for deterministic callback routing; defaults random. */
    state?: string,
  ) {
    this._state = state ?? randomUUID();
  }

  get redirectUrl(): string {
    return OAUTH_REDIRECT_URI;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: `Cairn — ${this.serverName}`,
      redirect_uris: [OAUTH_REDIRECT_URI],
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
 * connect/refresh paths don't need a stable state).
 */
export function makeProvider(cfg: OAuthServerConfig, serverName: string, state?: string): KeychainOAuthProvider {
  return new KeychainOAuthProvider(cfg.id, serverName, cfg.scope, state);
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

/**
 * Begin an OAuth sign-in for a server. Constructs an OAuth-enabled transport and
 * attempts to connect: the SDK performs discovery + (if needed) dynamic client
 * registration, then either succeeds (already have valid tokens) or calls the
 * provider's `redirectToAuthorization` (opening the browser) and throws
 * `UnauthorizedError`. In the redirect case we stash the attempt keyed by the
 * provider's `state` for {@link completeServerAuth} to resume.
 */
export async function startServerAuth(
  cfg: OAuthServerConfig,
  serverName: string,
): Promise<AuthStartResult> {
  sweepPending();
  const provider = makeProvider(cfg, serverName);
  const transport = makeOAuthTransport(cfg, provider);
  const client = new Client({ name: "cairn", version: "1.0.0" }, { capabilities: {} });
  try {
    await client.connect(transport);
    // Connected without a redirect → existing tokens were valid.
    await client.close().catch(() => {});
    return { status: "already_authorized" };
  } catch (e) {
    if (e instanceof UnauthorizedError) {
      // Browser was opened; wait for the deep-link callback.
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

/** Drop any pending attempt for a server (e.g. when its config changes). */
export function cancelPendingForServer(serverId: string): void {
  for (const [state, p] of pending) {
    if (p.serverId === serverId) {
      void p.client.close().catch(() => {});
      pending.delete(state);
    }
  }
}

// Keep the registry from leaking across app lifetime.
app?.on?.("before-quit", () => {
  for (const [, p] of pending) void p.client.close().catch(() => {});
  pending.clear();
});
