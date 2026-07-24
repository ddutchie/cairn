import { describe, it, expect, vi, beforeEach } from "vitest";

// In-memory file backing the secrets store (same approach as secure-store.test).
let virtualFiles: Record<string, string> = {};

vi.mock("electron", () => ({
  app: {
    isReady: () => true,
    getPath: (key: string) => (key === "userData" ? "/tmp/mcp-oauth-test" : `/mock/${key}`),
    on: () => {},
    setAsDefaultProtocolClient: () => true,
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

// The SDK modules are heavy and not needed for these pure/persistence tests; the
// provider only touches the secure store. Stub the transport/client/auth imports.
vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({ Client: class {} }));
vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({ StreamableHTTPClientTransport: class {} }));
vi.mock("@modelcontextprotocol/sdk/client/sse.js", () => ({ SSEClientTransport: class {} }));
vi.mock("@modelcontextprotocol/sdk/client/auth.js", () => ({
  UnauthorizedError: class extends Error {},
  auth: vi.fn(),
}));

import {
  parseOAuthCallback,
  KeychainOAuthProvider,
  hasTokens,
  signOut,
  getAccessToken,
  OAUTH_REDIRECT_URI,
} from "./mcp-oauth";
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";

beforeEach(() => {
  virtualFiles = {};
});

describe("parseOAuthCallback", () => {
  it("parses a well-formed callback", () => {
    expect(parseOAuthCallback("cairn://oauth/callback?code=abc&state=xyz")).toEqual({
      code: "abc",
      state: "xyz",
    });
  });

  it("tolerates triple-slash form", () => {
    const r = parseOAuthCallback("cairn:///oauth/callback?code=a&state=b");
    expect(r).toEqual({ code: "a", state: "b" });
  });

  it("rejects wrong scheme", () => {
    expect(parseOAuthCallback("https://oauth/callback?code=a&state=b")).toBeNull();
  });

  it("rejects wrong path", () => {
    expect(parseOAuthCallback("cairn://oauth/other?code=a&state=b")).toBeNull();
  });

  it("rejects deeper routes that merely end with oauth/callback", () => {
    expect(parseOAuthCallback("cairn://evil/oauth/callback?code=a&state=b")).toBeNull();
    expect(parseOAuthCallback("cairn://oauth/oauth/callback?code=a&state=b")).toBeNull();
    expect(parseOAuthCallback("cairn:///deep/oauth/callback?code=a&state=b")).toBeNull();
  });

  it("rejects missing code or state", () => {
    expect(parseOAuthCallback("cairn://oauth/callback?code=a")).toBeNull();
    expect(parseOAuthCallback("cairn://oauth/callback?state=b")).toBeNull();
  });

  it("rejects non-cairn / garbage", () => {
    expect(parseOAuthCallback("not a url")).toBeNull();
    expect(parseOAuthCallback("")).toBeNull();
  });
});

describe("KeychainOAuthProvider", () => {
  it("exposes the fixed redirect URI and a stable state", () => {
    const p = new KeychainOAuthProvider("srv1", "My Server", undefined, "fixed-state");
    expect(p.redirectUrl).toBe(OAUTH_REDIRECT_URI);
    expect(p.state()).toBe("fixed-state");
    expect(p.clientMetadata.redirect_uris).toEqual([OAUTH_REDIRECT_URI]);
  });

  it("includes scope in client metadata only when provided", () => {
    expect(new KeychainOAuthProvider("s", "n").clientMetadata.scope).toBeUndefined();
    expect(new KeychainOAuthProvider("s", "n", "read:x").clientMetadata.scope).toBe("read:x");
  });

  it("advertises a loopback redirect URI when one is supplied", () => {
    const loopback = "http://127.0.0.1:53682/callback";
    const p = new KeychainOAuthProvider("srv1", "My Server", undefined, "st", loopback);
    expect(p.redirectUrl).toBe(loopback);
    expect(p.clientMetadata.redirect_uris).toEqual([loopback]);
  });

  it("round-trips tokens, client info, and verifier via the keychain", () => {
    const p = new KeychainOAuthProvider("srv1", "My Server");

    expect(p.tokens()).toBeUndefined();
    expect(p.clientInformation()).toBeUndefined();

    p.saveTokens({ access_token: "tok", token_type: "Bearer", refresh_token: "ref" });
    p.saveClientInformation({ client_id: "cid", redirect_uris: [OAUTH_REDIRECT_URI] });
    p.saveCodeVerifier("verifier-123");

    expect(p.tokens()).toEqual({ access_token: "tok", token_type: "Bearer", refresh_token: "ref" });
    expect(p.clientInformation()).toMatchObject({ client_id: "cid" });
    expect(p.codeVerifier()).toBe("verifier-123");
    expect(hasTokens("srv1")).toBe(true);
  });

  it("isolates artefacts per server id", () => {
    new KeychainOAuthProvider("a", "A").saveTokens({ access_token: "ta", token_type: "Bearer" });
    expect(hasTokens("a")).toBe(true);
    expect(hasTokens("b")).toBe(false);
  });

  it("never writes a token in plaintext on disk", () => {
    new KeychainOAuthProvider("s", "n").saveTokens({ access_token: "super-secret-token", token_type: "Bearer" });
    expect(JSON.stringify(virtualFiles)).not.toContain("super-secret-token");
  });

  it("codeVerifier throws when none was saved", () => {
    expect(() => new KeychainOAuthProvider("none", "n").codeVerifier()).toThrow(/verifier/i);
  });

  it("signOut and invalidateCredentials clear stored artefacts", () => {
    const p = new KeychainOAuthProvider("srv1", "n");
    p.saveTokens({ access_token: "t", token_type: "Bearer" });
    p.saveClientInformation({ client_id: "c", redirect_uris: [OAUTH_REDIRECT_URI] });
    p.saveCodeVerifier("v");

    p.invalidateCredentials("tokens");
    expect(hasTokens("srv1")).toBe(false);
    expect(p.clientInformation()).toMatchObject({ client_id: "c" });

    signOut("srv1");
    expect(p.clientInformation()).toBeUndefined();
    expect(() => p.codeVerifier()).toThrow();
  });
});

describe("KeychainOAuthProvider — HTTP-service (toolType) namespace", () => {
  it("isolates service tokens from an MCP server of the same id", () => {
    const mcp = new KeychainOAuthProvider("dup", "MCP");
    const svc = new KeychainOAuthProvider("dup", "Service", undefined, undefined, undefined, "service");

    mcp.saveTokens({ access_token: "mcp-tok", token_type: "Bearer" });
    expect(hasTokens("dup", "mcp")).toBe(true);
    // The service namespace must NOT see the MCP token.
    expect(hasTokens("dup", "service")).toBe(false);
    expect(svc.tokens()).toBeUndefined();

    svc.saveTokens({ access_token: "svc-tok", token_type: "Bearer" });
    expect(hasTokens("dup", "service")).toBe(true);
    expect(svc.tokens()?.access_token).toBe("svc-tok");
    // MCP token still intact and distinct.
    expect(mcp.tokens()?.access_token).toBe("mcp-tok");

    // Signing the service out leaves the MCP token untouched.
    signOut("dup", "service");
    expect(hasTokens("dup", "service")).toBe(false);
    expect(hasTokens("dup", "mcp")).toBe(true);
  });

  it("stamps an absolute expires_at from expires_in on save", () => {
    const before = Date.now();
    const p = new KeychainOAuthProvider("svc", "S", undefined, undefined, undefined, "service");
    p.saveTokens({ access_token: "t", token_type: "Bearer", expires_in: 3600 });
    const stored = p.tokens() as { expires_at?: number } | undefined;
    expect(stored?.expires_at).toBeGreaterThanOrEqual(before + 3600 * 1000);
    expect(stored?.expires_at).toBeLessThanOrEqual(Date.now() + 3600 * 1000);
  });

  it("does not add expires_at when the token has no expires_in", () => {
    const p = new KeychainOAuthProvider("svc2", "S", undefined, undefined, undefined, "service");
    p.saveTokens({ access_token: "t", token_type: "Bearer" });
    expect((p.tokens() as { expires_at?: number }).expires_at).toBeUndefined();
  });
});

describe("getAccessToken", () => {
  const authMock = vi.mocked(auth);
  beforeEach(() => authMock.mockReset());

  const cfg = { id: "svc", serverUrl: "https://api.example.com", scope: "read" };

  function saveServiceTokens(t: Record<string, unknown>): void {
    new KeychainOAuthProvider("svc", "S", undefined, undefined, undefined, "service").saveTokens(
      t as never,
    );
  }

  it("returns null when the service was never authorized", async () => {
    expect(await getAccessToken(cfg, "S")).toBeNull();
    expect(authMock).not.toHaveBeenCalled();
  });

  it("returns the stored token without refreshing when not expired", async () => {
    saveServiceTokens({ access_token: "valid", token_type: "Bearer", expires_in: 3600 });
    expect(await getAccessToken(cfg, "S")).toBe("valid");
    expect(authMock).not.toHaveBeenCalled();
  });

  it("refreshes via auth() when the token is expired, then returns the rotated token", async () => {
    // Store an already-expired token (expires_at in the past) with a refresh token.
    saveServiceTokens({ access_token: "old", token_type: "Bearer", refresh_token: "r", expires_at: Date.now() - 1000 });
    authMock.mockImplementationOnce(async () => {
      // Simulate the SDK persisting rotated tokens through the provider.
      saveServiceTokens({ access_token: "rotated", token_type: "Bearer", refresh_token: "r2", expires_in: 3600 });
      return "AUTHORIZED";
    });
    expect(await getAccessToken(cfg, "S")).toBe("rotated");
    expect(authMock).toHaveBeenCalledOnce();
  });

  it("returns null when an expired token has no refresh_token", async () => {
    saveServiceTokens({ access_token: "old", token_type: "Bearer", expires_at: Date.now() - 1000 });
    expect(await getAccessToken(cfg, "S")).toBeNull();
    expect(authMock).not.toHaveBeenCalled();
  });

  it("returns null when the refresh attempt fails", async () => {
    saveServiceTokens({ access_token: "old", token_type: "Bearer", refresh_token: "r", expires_at: Date.now() - 1000 });
    authMock.mockRejectedValueOnce(new Error("refresh failed"));
    expect(await getAccessToken(cfg, "S")).toBeNull();
  });
});
