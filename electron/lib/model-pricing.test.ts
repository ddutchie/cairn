/**
 * Unit tests for electron/lib/model-pricing.ts
 */

import { describe, it, expect, beforeEach } from "vitest";
import { setModelPricing, pricePerMillion, estimateCostUsd } from "./model-pricing";

const PRICING = {
  "deepseek-v4-flash": { input: 0.04, output: 0.12 },
  "gpt-4o": { input: 2.5, output: 10 },
};

describe("model-pricing", () => {
  beforeEach(() => setModelPricing(PRICING));

  it("returns the exact price for a known model", () => {
    expect(pricePerMillion("gpt-4o")).toEqual({ input: 2.5, output: 10 });
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
