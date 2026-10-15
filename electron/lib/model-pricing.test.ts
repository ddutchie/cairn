/**
 * Unit tests for electron/lib/model-pricing.ts
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  setModelPricing,
  setNoTemperatureModels,
  supportsTemperature,
  resolveTemperatureForModel,
  pricePerMillion,
  estimateCostUsd,
  setEndpointProtocols,
  wireApiFor,
  wireBaseUrlFor,
} from "./model-pricing";

const PRICING = {
  "deepseek-v4-flash": { input: 0.04, output: 0.12 },
  "gpt-4o": { input: 2.5, output: 10 },
  "claude-cached": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
};

describe("model-pricing", () => {
  beforeEach(() => setModelPricing(PRICING));

  it("returns the exact price for a known model", () => {
    expect(pricePerMillion("gpt-4o")).toEqual({ input: 2.5, output: 10 });
  });

  it("exposes cache read/write prices when the model prices them", () => {
    expect(pricePerMillion("claude-cached")).toEqual({ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 });
  });

  it("prices cached input at the cache_read rate instead of full input", () => {
    // 1M prompt with 600K served from cache @ claude-cached rates:
    //   400K fresh * $3 + 600K cache read * $0.3 + 100K output * $15
    expect(estimateCostUsd("claude-cached", 1_000_000, 100_000, 600_000, 0))
      .toBeCloseTo(0.4 * 3 + 0.6 * 0.3 + 0.1 * 15, 6);
  });

  it("prices cache writes at the cache_write rate and falls back to input when unknown", () => {
    // 400K fresh + 200K cache write + 400K cache read + 0 output
    expect(estimateCostUsd("claude-cached", 1_000_000, 0, 400_000, 200_000))
      .toBeCloseTo(0.4 * 3 + 0.2 * 3.75 + 0.4 * 0.3, 6);
    // Model without cache prices → cached tokens billed at the input rate.
    expect(estimateCostUsd("gpt-4o", 1_000_000, 0, 600_000, 0))
      .toBeCloseTo(0.4 * 2.5 + 0.6 * 2.5, 6);
  });

  it("clamps cache counts that exceed the prompt size", () => {
    // cacheRead clamps to promptTokens; never a negative fresh portion.
    expect(estimateCostUsd("gpt-4o", 1000, 0, 5000, 0))
      .toBeCloseTo((1000 / 1e6) * 2.5, 6);
  });

  it("returns null for an unknown model", () => {
    expect(pricePerMillion("totally-unknown-model")).toBeNull();
  });

  it("fuzzy-matches gateway ids that end in the catalog id", () => {
    expect(pricePerMillion("playground-gpt-4o")).toEqual({ input: 2.5, output: 10 });
  });

  it("requires a separator boundary before a fuzzy suffix match", () => {
    // "chatgpt-4o" ends in "gpt-4o" but the preceding char is a letter — no match.
    expect(pricePerMillion("chatgpt-4o")).toBeNull();
    expect(pricePerMillion("my-gpt-4o")).toEqual({ input: 2.5, output: 10 });
    expect(pricePerMillion("openai/gpt-4o")).toEqual({ input: 2.5, output: 10 });
  });

  it("strips trailing region/date/reasoning suffixes to find a priced variant", () => {
    // gpt-4o-gcp, gpt-4o:thinking → strip the qualifier → gpt-4o pricing.
    expect(pricePerMillion("gpt-4o-gcp")).toEqual({ input: 2.5, output: 10 });
    expect(pricePerMillion("gpt-4o:thinking")).toEqual({ input: 2.5, output: 10 });
    expect(pricePerMillion("deepseek-v4-flash-0731")).toEqual({ input: 0.04, output: 0.12 });
  });

  it("estimates cost from per-1M pricing", () => {
    // 1M input + 200K output @ deepseek rates
    expect(estimateCostUsd("deepseek-v4-flash", 1_000_000, 200_000)).toBeCloseTo(0.04 + 0.024, 6);
  });

  it("returns undefined when pricing is unknown or tokens are zero", () => {
    expect(estimateCostUsd("nope", 100, 100)).toBeUndefined();
    expect(estimateCostUsd("gpt-4o", 0, 0)).toBeUndefined();
  });

  it("clears pricing when given an empty map", () => {
    setModelPricing({});
    expect(pricePerMillion("gpt-4o")).toBeNull();
    expect(estimateCostUsd("gpt-4o", 1000, 100)).toBeUndefined();
  });
});

describe("temperature capability gate", () => {
  beforeEach(() => setNoTemperatureModels(["gpt-5.6-luna", "claude-opus-4-7", "gpt-5.6"]));

  it("is permissive for unknown models", () => {
    expect(supportsTemperature("totally-unknown-model")).toBe(true);
    expect(resolveTemperatureForModel("totally-unknown-model", 0.3)).toBe(0.3);
  });

  it("never sends temperature to a model that declares it unsupported", () => {
    expect(supportsTemperature("gpt-5.6-luna")).toBe(false);
    expect(resolveTemperatureForModel("gpt-5.6-luna", 0.3)).toBeUndefined();
    expect(resolveTemperatureForModel("gpt-5.6-luna", 0)).toBeUndefined();
  });

  it("passes the requested value through for supporting/unknown models", () => {
    expect(resolveTemperatureForModel("glm-5.2", 0.5)).toBe(0.5);
    expect(resolveTemperatureForModel("glm-5.2", undefined)).toBeUndefined();
  });

  it("fuzzy-matches gateway ids that embed an unsupported model id", () => {
    expect(supportsTemperature("playground-gpt-5.6-luna")).toBe(false);
    expect(supportsTemperature("openai/gpt-5.6")).toBe(false);
  });

  it("clears the gate when given an empty list", () => {
    setNoTemperatureModels([]);
    expect(supportsTemperature("gpt-5.6-luna")).toBe(true);
  });
});

// OpenCode serves each model over one protocol: wireApiFor must mount the api the
// model speaks, and leave other endpoints (and an unloaded catalog) alone.
const GO = "https://opencode.ai/zen/go/v1";

afterEach(() => setEndpointProtocols(null));

describe("wireApiFor", () => {
  it("overrides the configured api with the model's protocol on OpenCode", () => {
    setEndpointProtocols({ "opencode-go/muse-spark-1.3-contributor": "responses", "opencode-go/qwen3.6-plus": "anthropic-messages" });
    expect(wireApiFor(GO, "muse-spark-1.3-contributor", "openai-completions")).toBe("openai-responses");
    expect(wireApiFor(GO, "qwen3.6-plus", "openai-completions")).toBe("anthropic-messages");
    expect(wireApiFor(GO, "deepseek-v4-flash", "openai-responses")).toBe("openai-completions");
  });

  it("keeps the configured api elsewhere and before the catalog loads", () => {
    expect(wireApiFor(GO, "muse-spark-1.3-contributor", "openai-completions")).toBe("openai-completions");
    setEndpointProtocols({ "opencode-go/muse-spark-1.3-contributor": "responses" });
    expect(wireApiFor("https://api.openai.com/v1", "gpt-5", "openai-responses")).toBe("openai-responses");
  });
});

describe("wireBaseUrlFor", () => {
  it("moves Gemini on OpenCode Go to the inference host, which has the Gemini route", () => {
    expect(wireBaseUrlFor("https://opencode.ai/zen/go/v1", "google-generative-ai")).toBe("https://opencode.ai/inference/go/v1");
    expect(wireBaseUrlFor("https://opencode.ai/zen/v1", "google-generative-ai")).toBe("https://opencode.ai/zen/v1");
    expect(wireBaseUrlFor("https://opencode.ai/zen/go/v1", "openai-completions")).toBe("https://opencode.ai/zen/go/v1");
  });
});
