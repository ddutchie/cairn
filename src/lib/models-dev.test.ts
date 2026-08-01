/**
 * Unit tests for the model-id normalization used by the models.dev context-window
 * lookup. The endpoint (or a gateway) may prepend a `provider:` prefix to the
 * model id — e.g. `merge:deepseek/deepseek-v4-flash` or `merge:deepseek-v4-flash`.
 * We must strip that so the underlying model still resolves in the catalog.
 */

import { describe, expect, it } from "vitest";
import { normalizeId } from "./models-dev";

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
