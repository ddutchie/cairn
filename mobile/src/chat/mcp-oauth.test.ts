/** The OAuth provider for a custom connector: a pre-registered client skips CIMD and dynamic registration. */
import { describe, expect, it, vi } from "vitest";

vi.mock("expo-secure-store", () => ({ getItemAsync: async () => null, setItemAsync: async () => {}, deleteItemAsync: async () => {} }));
vi.mock("expo-web-browser", () => ({}));
vi.mock("@modelcontextprotocol/sdk/client/auth.js", () => ({ auth: async () => "AUTHORIZED" }));

const { SecureStoreOAuthProvider, friendlyAuthError } = await import("./mcp-oauth");

describe("SecureStoreOAuthProvider", () => {
  it("uses CIMD and the https bounce page by default", async () => {
    const p = new SecureStoreOAuthProvider("s", "Server");
    expect(p.clientMetadataUrl).toMatch(/^https:\/\//);
    expect(p.redirectUrl).toBe("https://gerardbuilds.com/cairn/oauth");
    expect(await p.clientInformation()).toBeUndefined();
  });

  it("with the user's own client id returns it as the registered client and turns CIMD off", async () => {
    const p = new SecureStoreOAuthProvider("s", "Microsoft 365", "Mail.Read", { clientId: "abc-123" });
    expect(p.clientMetadataUrl).toBeUndefined();
    expect(await p.clientInformation()).toMatchObject({ client_id: "abc-123", redirect_uris: ["https://gerardbuilds.com/cairn/oauth"] });
  });

  it("advertises the redirect the user registered", async () => {
    const p = new SecureStoreOAuthProvider("s", "M365", undefined, { clientId: "abc", redirectUri: "cairn://oauth/callback" });
    expect(p.redirectUrl).toBe("cairn://oauth/callback");
    expect(p.clientMetadata.redirect_uris).toEqual(["cairn://oauth/callback"]);
  });
});

describe("friendlyAuthError", () => {
  it("names an admin redirect allowlist and the way out, instead of calling it desktop only", () => {
    const e = friendlyAuthError("Glean", "HTTP 403: redirect_uri https://x is not permitted by administrator policy.");
    expect(e.error).toMatch(/administrator/);
    expect(e.error).toContain("https://gerardbuilds.com/cairn/oauth");
    expect(e.error).toMatch(/client ID/);
  });
  it("keeps the generic wording for other registration failures", () => {
    expect(friendlyAuthError("X", "invalid_redirect_uri").error).toMatch(/desktop/);
  });
});
