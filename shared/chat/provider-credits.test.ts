import { describe, expect, it } from "vitest";
import {
  sameEndpoint,
  resolveCreditSpec,
  parseCredits,
  parseOpenRouterCredits,
  parseDeepSeekCredits,
  parseOpenAiGrantsCredits,
  parseNeuralwattCredits,
} from "./provider-credits";
import type { ProviderCreditsSpec } from "./registry-schema";

describe("sameEndpoint", () => {
  it("treats matching endpoints as equal", () => {
    expect(sameEndpoint("https://api.openai.com", "https://api.openai.com/v1")).toBe(true);
    expect(sameEndpoint("https://api.openai.com/v1", "https://api.openai.com")).toBe(true);
    expect(sameEndpoint("https://api.openai.com/v1", "https://api.openai.com/v1")).toBe(true);
  });

  it("rejects different endpoints", () => {
    expect(sameEndpoint("https://api.openai.com/v1", "https://api.neuralwatt.com/v1")).toBe(false);
  });
});

describe("resolveCreditSpec", () => {
  const providers = [
    { definition: { baseUrl: "https://api.openai.com/v1", credits: { url: "https://api.openai.com/v1/dashboard/billing/credit_grants", shape: "openai-grants" } as ProviderCreditsSpec } },
    { definition: { baseUrl: "https://api.neuralwatt.com/v1", credits: { url: "https://api.neuralwatt.com/v1/quota", shape: "neuralwatt" } as ProviderCreditsSpec } },
    { definition: { baseUrl: "https://api.merge.dev/v1", needsApiKey: true } },
  ];

  it("matches a provider by baseUrl, tolerating a missing /v1 segment", () => {
    expect(resolveCreditSpec("https://api.openai.com", providers)?.shape).toBe("openai-grants");
    expect(resolveCreditSpec("https://api.openai.com/v1", providers)?.shape).toBe("openai-grants");
  });

  it("returns the descriptor for neuralwatt", () => {
    const spec = resolveCreditSpec("https://api.neuralwatt.com/v1", providers);
    expect(spec?.url).toBe("https://api.neuralwatt.com/v1/quota");
    expect(spec?.shape).toBe("neuralwatt");
  });

  it("returns null for a provider without a credits descriptor", () => {
    expect(resolveCreditSpec("https://api.merge.dev/v1", providers)).toBeNull();
  });

  it("returns null when no provider matches", () => {
    expect(resolveCreditSpec("https://example.com/v1", providers)).toBeNull();
  });
});

describe("parseCredits", () => {
  it("routes by declared shape", () => {
    expect(parseCredits("neuralwatt", { balance: { credits_remaining_usd: 32.6 } })?.remaining).toBe(32.6);
    expect(parseCredits("deepseek", { balance_infos: [{ currency: "CNY", total_balance: "12.3" }] })?.remaining).toBe(12.3);
    expect(parseCredits("openai-grants", { total_available: 4.2 })?.remaining).toBe(4.2);
    expect(parseCredits("openrouter", { data: { limit_remaining: 7 } })?.remaining).toBe(7);
  });

  it("returns null for an unrecognised shape", () => {
    expect(parseCredits("bogus", { data: { limit_remaining: 7 } })?.remaining).toBe(7);
    expect(parseCredits("bogus", {})).toBeNull();
  });
});

describe("parseNeuralwattCredits", () => {
  it("reads the three USD balance fields", () => {
    const info = parseNeuralwattCredits({
      balance: { credits_remaining_usd: 32.6774, total_credits_usd: 52.34, credits_used_usd: 19.6626 },
    });
    expect(info).toEqual({ remaining: 32.6774, usage: 19.6626, limit: 52.34, isFreeTier: null, currency: "USD" });
  });

  it("accepts decimal-string fields", () => {
    const info = parseNeuralwattCredits({ balance: { credits_remaining_usd: "32.6" } });
    expect(info?.remaining).toBe(32.6);
    expect(info?.usage).toBeNull();
  });

  it("returns null without a balance object", () => {
    expect(parseNeuralwattCredits({ key: "info" })).toBeNull();
    expect(parseNeuralwattCredits({ balance: {} })).toBeNull();
  });

  it("drops NaN fields individually", () => {
    const info = parseNeuralwattCredits({ balance: { credits_remaining_usd: "abc", total_credits_usd: 10 } });
    expect(info?.remaining).toBeNull();
    expect(info?.limit).toBe(10);
  });
});
