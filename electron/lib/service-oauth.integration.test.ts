import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createServer, type Server } from "http";
import type { AddressInfo } from "net";

/**
 * Integration test for the HTTP-service OAuth core against a REAL mock
 * authorization server — the SDK's auth() / refreshAuthorization() are NOT
 * mocked here (unlike mcp-oauth.test.ts). This exercises the parts the unit
 * tests stub out: RFC 9728 discovery, dynamic client registration, the
 * refresh_token grant over the wire, keychain persistence, and expires_at
 * stamping, so we have confidence the token round-trip works before a manual
 * click-through in the app.
 */

// In-memory secrets backing (same approach as secure-store.test / mcp-oauth.test).
let virtualFiles: Record<string, string> = {};

vi.mock("electron", () => ({
  app: {
    isReady: () => true,
    getPath: (k: string) => (k === "userData" ? "/tmp/svc-oauth-int" : `/mock/${k}`),
    on: () => {},
  },
  shell: { openExternal: vi.fn(() => Promise.resolve()) },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(`enc:${s}`, "utf-8"),
    decryptString: (b: Buffer) => b.toString("utf-8").replace(/^enc:/, ""),
  },
}));

vi.mock("fs", () => ({
  default: {
    existsSync: (p: string) => Object.prototype.hasOwnProperty.call(virtualFiles, p),
    readFileSync: (p: string) => {
      if (!Object.prototype.hasOwnProperty.call(virtualFiles, p)) throw new Error("ENOENT");
      return virtualFiles[p];
    },
    writeFileSync: (p: string, data: string) => {
      virtualFiles[p] = data;
    },
  },
}));

// These SDK submodules are only needed for their real exports; the transport
// classes are never constructed on the service path, but the module graph pulls
// them in, so provide harmless stubs. auth.js is the REAL module (not stubbed).
vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({ Client: class {} }));
vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({ StreamableHTTPClientTransport: class {} }));
vi.mock("@modelcontextprotocol/sdk/client/sse.js", () => ({ SSEClientTransport: class {} }));

import { KeychainOAuthProvider, getAccessToken } from "./mcp-oauth";
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";

// ── Mock authorization server ────────────────────────────────────────────────

interface MockASOptions {
  /** access_token returned by the token endpoint (default rotates per call). */
  onToken?: (grant: string, body: URLSearchParams) => Record<string, unknown>;
}

interface MockAS {
  origin: string;
  tokenCalls: { grant: string; body: URLSearchParams }[];
  registerCalls: number;
  close: () => Promise<void>;
}

async function startMockAS(opts: MockASOptions = {}): Promise<MockAS> {
  const tokenCalls: { grant: string; body: URLSearchParams }[] = [];
  let registerCalls = 0;
  let origin = "";

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", origin);
    const json = (obj: unknown, status = 200) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(obj));
    };

    // RFC 9728 protected-resource metadata → points at ourselves as the AS.
    if (url.pathname === "/.well-known/oauth-protected-resource") {
      return json({ resource: origin, authorization_servers: [origin] });
    }
    // RFC 8414 authorization-server metadata.
    if (
      url.pathname === "/.well-known/oauth-authorization-server" ||
      url.pathname === "/.well-known/openid-configuration"
    ) {
      return json({
        issuer: origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        registration_endpoint: `${origin}/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
      });
    }
    // Dynamic client registration.
    if (url.pathname === "/register" && req.method === "POST") {
      registerCalls++;
      return json(
        {
          client_id: "mock-client-id",
          redirect_uris: ["http://127.0.0.1:0/callback"],
          token_endpoint_auth_method: "none",
        },
        201,
      );
    }
    // Token endpoint (code exchange + refresh grant).
    if (url.pathname === "/token" && req.method === "POST") {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const body = new URLSearchParams(raw);
        const grant = body.get("grant_type") ?? "";
        tokenCalls.push({ grant, body });
        const tokens = opts.onToken
          ? opts.onToken(grant, body)
          : {
              access_token: grant === "refresh_token" ? "rotated-access" : "initial-access",
              token_type: "Bearer",
              expires_in: 3600,
              refresh_token: "refresh-1",
            };
        json(tokens);
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  origin = `http://127.0.0.1:${port}`;

  return {
    get origin() {
      return origin;
    },
    tokenCalls,
    get registerCalls() {
      return registerCalls;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("HTTP-service OAuth — real refresh round-trip (getAccessToken)", () => {
  let as: MockAS;

  beforeEach(async () => {
    virtualFiles = {};
    as = await startMockAS();
  });
  afterEach(async () => {
    await as.close();
  });

  function seedExpiredTokensWithClient(serviceId: string) {
    // A provider with a registered client + an expired access token that still
    // has a refresh_token, exactly the state getAccessToken must recover from.
    const p = new KeychainOAuthProvider(serviceId, "S", undefined, undefined, undefined, "service");
    p.saveClientInformation({
      client_id: "mock-client-id",
      redirect_uris: ["http://127.0.0.1:0/callback"],
    });
    p.saveTokens({
      access_token: "stale",
      token_type: "Bearer",
      refresh_token: "refresh-1",
      // Force expiry: stamp expires_at in the past directly.
      expires_in: -10,
    } as never);
  }

  it("refreshes an expired token via the real refresh_token grant and returns the rotated token", async () => {
    seedExpiredTokensWithClient("svc-refresh");
    const token = await getAccessToken(
      { id: "svc-refresh", serverUrl: as.origin, scope: "read" },
      "S",
    );
    expect(token).toBe("rotated-access");
    // The token endpoint was hit with a refresh_token grant.
    expect(as.tokenCalls.some((c) => c.grant === "refresh_token")).toBe(true);

    // The rotated token is persisted with a fresh absolute expiry, so an
    // immediate second call does NOT hit the network again.
    const before = as.tokenCalls.length;
    const again = await getAccessToken({ id: "svc-refresh", serverUrl: as.origin }, "S");
    expect(again).toBe("rotated-access");
    expect(as.tokenCalls.length).toBe(before);
  });

  it("returns null when the refresh grant is rejected by the server", async () => {
    await as.close();
    as = await startMockASRejectingToken();
    seedExpiredTokensWithClient("svc-reject");
    const token = await getAccessToken({ id: "svc-reject", serverUrl: as.origin }, "S");
    expect(token).toBeNull();
  });

  it("does not refresh when the stored token is still valid", async () => {
    const p = new KeychainOAuthProvider("svc-valid", "S", undefined, undefined, undefined, "service");
    p.saveClientInformation({ client_id: "mock-client-id", redirect_uris: [] });
    p.saveTokens({ access_token: "good", token_type: "Bearer", refresh_token: "r", expires_in: 3600 } as never);

    const token = await getAccessToken({ id: "svc-valid", serverUrl: as.origin }, "S");
    expect(token).toBe("good");
    expect(as.tokenCalls.length).toBe(0);
  });
});

describe("HTTP-service OAuth — real sign-in round-trip (auth + code exchange)", () => {
  let as: MockAS;
  beforeEach(async () => {
    virtualFiles = {};
    as = await startMockAS();
  });
  afterEach(async () => {
    await as.close();
  });

  it("runs discovery + DCR + code exchange and persists stamped tokens", async () => {
    // This is exactly what startServiceAuth's loopback completion does: build a
    // provider with a loopback redirect, then call auth() with the authorization
    // code the browser returned. First a no-code call to run discovery + DCR +
    // save the PKCE verifier (the SDK opens the "browser" via redirectTo…, stubbed).
    const provider = new KeychainOAuthProvider(
      "svc-signin",
      "S",
      "read",
      "state-1",
      "http://127.0.0.1:0/callback",
      "service",
    );

    const first = await auth(provider, { serverUrl: as.origin, scope: "read" });
    expect(first).toBe("REDIRECT");
    expect(as.registerCalls).toBe(1); // dynamic client registration happened
    expect(provider.clientInformation()?.client_id).toBe("mock-client-id");

    // Now the "browser" returned ?code=… → exchange it for tokens.
    const done = await auth(provider, {
      serverUrl: as.origin,
      authorizationCode: "auth-code-123",
      scope: "read",
    });
    expect(done).toBe("AUTHORIZED");

    // The token endpoint saw an authorization_code grant, and tokens were
    // persisted with an absolute expires_at (Phase A stamping).
    expect(as.tokenCalls.some((c) => c.grant === "authorization_code")).toBe(true);
    const stored = provider.tokens() as { access_token?: string; expires_at?: number } | undefined;
    expect(stored?.access_token).toBe("initial-access");
    expect(typeof stored?.expires_at).toBe("number");
    expect(stored!.expires_at!).toBeGreaterThan(Date.now());

    // And getAccessToken now returns it without any further network call.
    const before = as.tokenCalls.length;
    const token = await getAccessToken({ id: "svc-signin", serverUrl: as.origin, scope: "read" }, "S");
    expect(token).toBe("initial-access");
    expect(as.tokenCalls.length).toBe(before);
  });
});

/** Variant AS whose /token always 400s (invalid_grant), to test refresh failure. */
async function startMockASRejectingToken(): Promise<MockAS> {
  const tokenCalls: { grant: string; body: URLSearchParams }[] = [];
  let origin = "";
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", origin);
    const json = (obj: unknown, status = 200) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    if (url.pathname === "/.well-known/oauth-protected-resource")
      return json({ resource: origin, authorization_servers: [origin] });
    if (
      url.pathname === "/.well-known/oauth-authorization-server" ||
      url.pathname === "/.well-known/openid-configuration"
    )
      return json({
        issuer: origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        registration_endpoint: `${origin}/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
      });
    if (url.pathname === "/token" && req.method === "POST") {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        tokenCalls.push({ grant: new URLSearchParams(raw).get("grant_type") ?? "", body: new URLSearchParams(raw) });
        json({ error: "invalid_grant", error_description: "refresh token expired" }, 400);
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  origin = `http://127.0.0.1:${port}`;
  return {
    get origin() {
      return origin;
    },
    tokenCalls,
    registerCalls: 0,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
