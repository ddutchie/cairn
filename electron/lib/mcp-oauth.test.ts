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
vi.mock("@modelcontextprotocol/sdk/client/auth.js", () => ({ UnauthorizedError: class extends Error {} }));

import {
  parseOAuthCallback,
  KeychainOAuthProvider,
  hasTokens,
  signOut,
  OAUTH_REDIRECT_URI,
} from "./mcp-oauth";

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
