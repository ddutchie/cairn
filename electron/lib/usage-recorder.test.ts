/**
 * Unit tests for electron/lib/usage-recorder.ts
 */

import { describe, it, expect } from "vitest";
import { resolveProviderName, extractCost } from "./usage-recorder";

describe("resolveProviderName", () => {
  it("resolves well-known providers from the base URL hostname", () => {
    expect(resolveProviderName("https://api.deepseek.com", "openai")).toBe("DeepSeek");
    expect(resolveProviderName("https://api.deepseek.com/v1", "openai")).toBe("DeepSeek");
    expect(resolveProviderName("https://openrouter.ai/api/v1", "openai")).toBe("OpenRouter");
    expect(resolveProviderName("https://api.neuralwatt.com", "openai")).toBe("NeuralWatt");
    expect(resolveProviderName("https://api.openai.com/v1", "openai")).toBe("OpenAI");
    expect(resolveProviderName("https://api.together.xyz/v1", "openai")).toBe("Together AI");
  });

  it("falls back to the provider slug when the host is unknown", () => {
    expect(resolveProviderName("https://custom.example.com/v1", "openrouter")).toBe("OpenRouter");
    expect(resolveProviderName(undefined, "openrouter")).toBe("OpenRouter");
  });

  it("labels unknown non-local gateways by hostname instead of 'openai'", () => {
    expect(resolveProviderName("https://api-gateway.merge.dev/v1/openai", "openai")).toBe("api-gateway.merge.dev");
  });

  it("keeps local endpoints as Local", () => {
    expect(resolveProviderName("http://127.0.0.1:8080/v1", "localllm")).toBe("Local");
    expect(resolveProviderName("http://localhost:1234/v1", "openai")).toBe("Local");
    expect(resolveProviderName("http://192.168.1.50:11434/v1", "localllm")).toBe("Local");
  });

  it("defaults to OpenAI when nothing identifiable", () => {
    expect(resolveProviderName(undefined, undefined)).toBe("OpenAI");
    expect(resolveProviderName(undefined, "openai")).toBe("OpenAI");
  });
});

describe("extractCost", () => {
  it("reads a numeric chunk cost", () => {
    expect(extractCost(0.0019, undefined)).toBe(0.0019);
  });
  it("reads request_cost_usd from an object cost", () => {
    expect(extractCost({ request_cost_usd: 0.5 }, undefined)).toBe(0.5);
  });
  it("reads usage.cost as a fallback", () => {
    expect(extractCost(undefined, { cost: 1.25 })).toBe(1.25);
  });
  it("returns undefined when the provider reports nothing", () => {
    expect(extractCost(undefined, undefined)).toBeUndefined();
  });
});
