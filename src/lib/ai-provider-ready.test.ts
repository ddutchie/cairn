import { describe, it, expect } from "vitest";
import { isAIProviderReady } from "./ai-provider-ready";

const OPENAI = "https://api.openai.com";

describe("isAIProviderReady", () => {
  it("is false for the fresh-install default", () => {
    expect(isAIProviderReady({ baseUrl: OPENAI, apiKey: "" })).toBe(false);
  });

  it("is true with a key on the active connection", () => {
    expect(isAIProviderReady({ baseUrl: OPENAI, apiKey: "secret://llm:1/apiKey" })).toBe(true);
  });

  it("ignores a whitespace-only key", () => {
    expect(isAIProviderReady({ baseUrl: OPENAI, apiKey: "   " })).toBe(false);
  });

  it("is true for a selected no-key provider on the local network", () => {
    const saved = [{ id: "lan" }];
    expect(isAIProviderReady({ baseUrl: "http://192.168.1.50:11434/v1", apiKey: "", activeProviderId: "lan" }, saved)).toBe(true);
  });

  it("is false when the active provider id points at a deleted provider", () => {
    expect(isAIProviderReady({ baseUrl: OPENAI, apiKey: "", activeProviderId: "gone" }, [{ id: "other" }])).toBe(false);
  });

  it("does not count a key that belongs to another, inactive provider", () => {
    expect(isAIProviderReady({ baseUrl: OPENAI, apiKey: "" }, [{ id: "other" }])).toBe(false);
  });

  it.each(["http://localhost:11434/v1", "http://127.0.0.1:8000", "http://[::1]:8000/v1", "http://localhost"])(
    "is true for the local endpoint %s without a provider",
    (baseUrl) => {
      expect(isAIProviderReady({ baseUrl, apiKey: "" })).toBe(true);
    },
  );

  it("is not fooled by a host that only starts with localhost", () => {
    expect(isAIProviderReady({ baseUrl: "https://localhost.example.com", apiKey: "" })).toBe(false);
  });
});
