/**
 * Unit tests for electron/lib/model-pricing.ts
 */

import { describe, it, expect, beforeEach } from "vitest";
import { setModelPricing, pricePerMillion, estimateCostUsd } from "./model-pricing";

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
