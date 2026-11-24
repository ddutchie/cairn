import { describe, it, expect } from "vitest";
import { customConnectorId, parseCustomMcp } from "./custom-connector";

const base = { name: "Gleam", url: "https://mcp.gleam.example/v1", authMode: "oauth" as const };

describe("parseCustomMcp", () => {
  it("accepts a plain https server and trims the name", () => {
    const r = parseCustomMcp({ ...base, name: "  Gleam ", authMode: "none" });
    expect(r).toEqual({ ok: true, value: { name: "Gleam", baseUrl: "https://mcp.gleam.example/v1", authMode: "none" } });
  });
  it("rejects a missing name, a bad URL, http and embedded credentials", () => {
    expect(parseCustomMcp({ ...base, name: " " }).ok).toBe(false);
    expect(parseCustomMcp({ ...base, url: "gleam" }).ok).toBe(false);
    expect(parseCustomMcp({ ...base, url: "http://x.example" }).ok).toBe(false);
    expect(parseCustomMcp({ ...base, url: "https://u:p@x.example" }).ok).toBe(false);
  });
  it("keeps OAuth fields only for oauth and collapses scope whitespace", () => {
    const withAuth = parseCustomMcp({ ...base, scope: " a   b ", clientId: " abc ", redirectUri: "cairn://oauth/callback" });
    expect(withAuth).toMatchObject({ ok: true, value: { oauthScope: "a b", oauthClientId: "abc", oauthRedirectUri: "cairn://oauth/callback" } });
    const noAuth = parseCustomMcp({ ...base, authMode: "none", scope: "a", clientId: "abc" });
    expect(noAuth.ok && noAuth.value.oauthClientId).toBeFalsy();
  });
  it("only accepts a redirect URI alongside a client id, and never an unsafe scheme", () => {
    expect(parseCustomMcp({ ...base, redirectUri: "https://x.example/cb" }).ok).toBe(false);
    for (const redirectUri of ["http://x.example/cb", "javascript:alert(1)", "not a url"]) {
      expect(parseCustomMcp({ ...base, clientId: "abc", redirectUri }).ok).toBe(false);
    }
    // Only addresses the sign-in session can finish on are allowed.
    expect(parseCustomMcp({ ...base, clientId: "abc", redirectUri: "https://x.example/cb" }).ok).toBe(false);
    expect(parseCustomMcp({ ...base, clientId: "abc", redirectUri: "cairn://oauth/custom" }).ok).toBe(false);
    expect(parseCustomMcp({ ...base, clientId: "abc", redirectUri: "https://gerardbuilds.com/cairn/oauth" }).ok).toBe(true);
  });
});

describe("customConnectorId", () => {
  it("is prefixed, slugged and varies with the random source", () => {
    expect(customConnectorId("Microsoft 365!", () => 0)).toBe("custom-microsoft-365-0");
    expect(customConnectorId("Microsoft 365!", () => 0.5)).not.toBe(customConnectorId("Microsoft 365!", () => 0.25));
    expect(customConnectorId("!!!", () => 0)).toBe("custom-server-0");
  });
});
