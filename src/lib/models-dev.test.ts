/**
 * Unit tests for the model-id normalization used by the models.dev context-window
 * lookup. The endpoint (or a gateway) may prepend a `provider:` prefix to the
 * model id — e.g. `merge:deepseek/deepseek-v4-flash` or `merge:deepseek-v4-flash`.
 * We must strip that so the underlying model still resolves in the catalog.
 *
 * Also covers the effective-temperature resolver: the models.dev `temperature`
 * capability gate (never send to a model that declares it unsupported) and the
 * Auto/omit default (no user value → undefined → field omitted → vendor default).
 */

import { describe, expect, it, beforeEach } from "vitest";
import { normalizeId, effectiveTemperatureForModel, setModelInfoCacheForTest } from "./models-dev";
import type { ModelInfo } from "../../shared/models/model-catalog";

const stub = (temperature: boolean | null): ModelInfo => ({
  context: 128000,
  maxOutput: 32000,
  input: 1,
  output: 2,
  cacheRead: null,
  cacheWrite: null,
  modes: ["text"],
  toolCall: true,
  reasoning: true,
  temperature,
  provider: "test",
});

describe("normalizeId", () => {
  it("strips a bare provider prefix with a slash path", () => {
    expect(normalizeId("deepseek/deepseek-v4-flash")).toBe("deepseek-v4-flash");
  });

  it("strips a `provider:` prefix in front of a slash path", () => {
    // The reported case: endpoint appends `merge:` in front of the full id.
    expect(normalizeId("merge:deepseek/deepseek-v4-flash")).toBe("deepseek-v4-flash");
  });

  it("strips a `provider:` prefix when there is no slash path", () => {
    // Regression: previously `.split(":")[0]` grabbed the provider ("merge")
    // instead of the model id.
    expect(normalizeId("merge:deepseek-v4-flash")).toBe("deepseek-v4-flash");
  });

  it("does not treat a `:thinking` variant suffix as a provider prefix", () => {
    // `gpt-4:thinking` — the ":thinking" is a variant, not a provider. The model
    // id must survive; only the suffix is dropped.
    expect(normalizeId("gpt-4:thinking")).toBe("gpt-4");
    expect(normalizeId("claude-opus-4:thinking")).toBe("claude-opus-4");
  });

  it("does not treat a hyphenated `:variant` suffix as a provider prefix", () => {
    // Regression: `gpt-4:thinking-v2` was mistaken for a provider prefix and
    // reduced to `thinking-v2` (the `-` in the tail tripped the strip). The
    // model id must be preserved (`:thinking-v2` handled by the later `:` split).
    expect(normalizeId("gpt-4:thinking-v2")).toBe("gpt-4");
    expect(normalizeId("gpt-4:high")).toBe("gpt-4");
    expect(normalizeId("gpt-4:reasoning-high")).toBe("gpt-4");
  });

  it("handles a provider prefix combined with a thinking suffix", () => {
    expect(normalizeId("merge:deepseek/deepseek-v4-flash:thinking")).toBe("deepseek-v4-flash");
  });

  it("leaves already-clean ids untouched", () => {
    expect(normalizeId("deepseek-v4-flash")).toBe("deepseek-v4-flash");
    expect(normalizeId("claude-opus-4")).toBe("claude-opus-4");
  });

  it("does not let a version-tag strip swallow a trailing word", () => {
    // Regression: `-v4-flash` / `-luna` were being eaten by a greedy `-v\d+.*$`.
    expect(normalizeId("deepseek-v4-flash")).toBe("deepseek-v4-flash");
    expect(normalizeId("merge:gpt-5.6-luna")).toBe("gpt-5.6-luna");
  });

  it("still strips pure trailing version tags", () => {
    expect(normalizeId("some-model-v1")).toBe("some-model");
    expect(normalizeId("some-model-v1:0")).toBe("some-model");
  });

  it("still resolves the documented gateway/proxy shapes", () => {
    expect(normalizeId("playground-claude-opus-4-8")).toBe("claude-opus-4-8");
    expect(normalizeId("us.anthropic.claude-opus-4-7")).toBe("claude-opus-4-7");
  });
});

describe("effectiveTemperatureForModel", () => {
  beforeEach(() => {
    setModelInfoCacheForTest(null);
  });

  it("never sends temperature to a model that declares it unsupported", () => {
    setModelInfoCacheForTest({ "gpt-5.6-luna": stub(false) });
    // Even an explicit user value must not be sent — the model manages sampling.
    expect(effectiveTemperatureForModel("gpt-5.6-luna", 0.3)).toBeUndefined();
    expect(effectiveTemperatureForModel("gpt-5.6-luna", 0)).toBeUndefined();
    expect(effectiveTemperatureForModel("gpt-5.6-luna", undefined)).toBeUndefined();
  });

  it("honours an explicit user value for a model that supports temperature", () => {
    setModelInfoCacheForTest({ "glm-5.2": stub(true) });
    expect(effectiveTemperatureForModel("glm-5.2", 0.3)).toBe(0.3);
    expect(effectiveTemperatureForModel("glm-5.2", 0)).toBe(0);
  });

  it("omits the field when the user hasn't set a temperature (Auto)", () => {
    setModelInfoCacheForTest({ "glm-5.2": stub(true) });
    expect(effectiveTemperatureForModel("glm-5.2", undefined)).toBeUndefined();
    expect(effectiveTemperatureForModel("glm-5.2", null)).toBeUndefined();
  });

  it("is permissive for unknown models: honour explicit, omit when unset", () => {
    // No cache seeded → model unknown.
    expect(effectiveTemperatureForModel("unknown-model", 0.5)).toBe(0.5);
    expect(effectiveTemperatureForModel("unknown-model", undefined)).toBeUndefined();
  });
});
