import { describe, it, expect } from "vitest";
import { parseOAuthCallback } from "./oauth-callback";

describe("parseOAuthCallback", () => {
  it("parses a well-formed callback with state", () => {
    expect(parseOAuthCallback("cairn://oauth/callback?code=abc&state=xyz")).toEqual({ code: "abc", state: "xyz" });
  });

  it("tolerates the triple-slash form", () => {
    expect(parseOAuthCallback("cairn:///oauth/callback?code=a&state=b")).toEqual({ code: "a", state: "b" });
  });

  it("accepts an empty state (state=) — required for Tavily-style callbacks", () => {
    // Real device capture: cairn://oauth/callback?code=…&state=
    expect(parseOAuthCallback("cairn://oauth/callback?code=FIgV_E8&state=")).toEqual({ code: "FIgV_E8", state: "" });
  });

  it("accepts a missing state entirely (state is optional in OAuth 2.1)", () => {
    expect(parseOAuthCallback("cairn://oauth/callback?code=abc")).toEqual({ code: "abc", state: "" });
  });

  it("requires the authorization code", () => {
    expect(parseOAuthCallback("cairn://oauth/callback?state=b")).toBeNull();
    expect(parseOAuthCallback("cairn://oauth/callback")).toBeNull();
  });

  it("rejects wrong scheme / path / deeper routes", () => {
    expect(parseOAuthCallback("https://oauth/callback?code=a")).toBeNull();
    expect(parseOAuthCallback("cairn://oauth/other?code=a")).toBeNull();
    expect(parseOAuthCallback("cairn://evil/oauth/callback?code=a")).toBeNull();
    expect(parseOAuthCallback("cairn://oauth/oauth/callback?code=a")).toBeNull();
  });

  it("rejects non-cairn / garbage", () => {
    expect(parseOAuthCallback("not a url")).toBeNull();
    expect(parseOAuthCallback("")).toBeNull();
  });
});
