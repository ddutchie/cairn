import { describe, expect, it } from "vitest";
import {
  createAppIdentity,
  isOpencodeEndpoint,
  opencodeHeaders,
  opencodeSessionHeaders,
  setCurrentOpencodeSessionId,
  getCurrentOpencodeSessionId,
} from "./app-identity";

describe("app-identity", () => {
  it("builds the user agent and identity from a version", () => {
    const { userAgent, identity } = createAppIdentity("3.0.5");
    expect(userAgent).toBe("cairn/3.0.5");
    expect(identity).toEqual({
      product: "cairn",
      version: "3.0.5",
      url: "https://github.com/ddutchie/cairn",
    });
  });

  it("detects opencode endpoints case-insensitively", () => {
    expect(isOpencodeEndpoint("https://opencode.ai/zen")).toBe(true);
    expect(isOpencodeEndpoint("https://OPENCODE.AI/v1")).toBe(true);
    expect(isOpencodeEndpoint("https://api.openai.com/v1")).toBe(false);
  });

  it("tracks the current session id", () => {
    setCurrentOpencodeSessionId("s1");
    expect(getCurrentOpencodeSessionId()).toBe("s1");
    expect(opencodeSessionHeaders()).toEqual({ "x-opencode-session": "s1" });
    setCurrentOpencodeSessionId(null);
    expect(opencodeSessionHeaders()).toEqual({});
  });

  it("builds opencode-aware headers only for opencode endpoints", () => {
    setCurrentOpencodeSessionId("s1");
    expect(opencodeHeaders("cairn/3.0.5", "https://opencode.ai/zen")).toEqual({
      "User-Agent": "cairn/3.0.5",
      "x-opencode-session": "s1",
    });
    expect(opencodeHeaders("cairn/3.0.5", "https://api.openai.com/v1")).toEqual({
      "User-Agent": "cairn/3.0.5",
    });
    setCurrentOpencodeSessionId(null);
  });
});
