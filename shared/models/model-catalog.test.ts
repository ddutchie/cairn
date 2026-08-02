/**
 * Unit tests for the shared models.dev catalog helpers: parsing, model-id
 * normalization, fuzzy lookup, and per-1M cost formatting.
 */

import { describe, expect, it } from "vitest";
import {
  formatModelCost,
  lookupModelInfo,
  modelInputChips,
  normalizeModelId,
  parseModelCatalog,
  providerLogoUrl,
  supportsImageInput,
} from "./model-catalog";

describe("parseModelCatalog", () => {
  it("flattens the models.dev provider tree into id → ModelInfo", () => {
    const map = parseModelCatalog({
      openai: {
        models: {
          "gpt-5": {
            limit: { context: 1000000, output: 128000 },
            cost: { input: 1.25, output: 10 },
            modalities: { input: ["text", "image", "pdf"] },
            tool_call: true,
          },
        },
      },
      anthropic: {
        models: {
          "claude-4": { limit: { context: 1000000 } },
        },
      },
    });
    expect(map["gpt-5"]).toEqual({
      context: 1000000,
      input: 1.25,
      output: 10,
      modes: ["text", "image", "pdf"],
      toolCall: true,
      provider: "openai",
    });
    expect(map["claude-4"]).toEqual({
      context: 1000000,
      input: null,
      output: null,
      modes: [],
      toolCall: null,
      provider: "anthropic",
    });
  });

  it("tolerates missing/odd fields", () => {
    const map = parseModelCatalog({
      deepseek: { models: { "deepseek-v4-flash": { limit: { context: "n/a" }, tool_call: "yes" } } },
    });
    expect(map["deepseek-v4-flash"]).toEqual({
      context: null,
      input: null,
      output: null,
      modes: [],
      toolCall: null,
      provider: "deepseek",
    });
  });

  it("returns an empty map for junk input", () => {
    expect(parseModelCatalog(null)).toEqual({});
    expect(parseModelCatalog("nope")).toEqual({});
  });
});

describe("supportsImageInput", () => {
  it("is permissive when the model is unknown", () => {
    expect(supportsImageInput(null)).toBe(true);
  });

  it("follows the catalog modalities", () => {
    expect(supportsImageInput({ modes: ["text", "image"] } as never)).toBe(true);
    expect(supportsImageInput({ modes: ["text", "pdf"] } as never)).toBe(false);
    expect(supportsImageInput({ modes: [] } as never)).toBe(false);
  });
});

describe("modelInputChips", () => {
  const chip = (info: { modes: string[] }) => modelInputChips(info as never).map((c) => c.label);

  it("renders stable-ordered labels for present modes", () => {
    expect(chip({ modes: ["text", "image", "pdf"] })).toEqual(["T", "I", "PDF"]);
    expect(chip({ modes: ["audio", "image"] })).toEqual(["I", "A"]);
  });

  it("returns nothing for unknown models or no modes", () => {
    expect(modelInputChips(null)).toEqual([]);
    expect(chip({ modes: [] })).toEqual([]);
  });
});

describe("normalizeModelId", () => {
  it("strips a bare provider prefix with a slash path", () => {
    expect(normalizeModelId("deepseek/deepseek-v4-flash")).toBe("deepseek-v4-flash");
  });

  it("strips a `provider:` prefix in front of a slash path", () => {
    expect(normalizeModelId("merge:deepseek/deepseek-v4-flash")).toBe("deepseek-v4-flash");
  });

  it("strips a `provider:` prefix when there is no slash path", () => {
    expect(normalizeModelId("merge:deepseek-v4-flash")).toBe("deepseek-v4-flash");
  });

  it("does not treat a `:thinking` variant suffix as a provider prefix", () => {
    expect(normalizeModelId("gpt-4:thinking")).toBe("gpt-4");
    expect(normalizeModelId("claude-opus-4:thinking")).toBe("claude-opus-4");
  });

  it("does not treat a hyphenated `:variant` suffix as a provider prefix", () => {
    expect(normalizeModelId("gpt-4:thinking-v2")).toBe("gpt-4");
    expect(normalizeModelId("gpt-4:high")).toBe("gpt-4");
    expect(normalizeModelId("gpt-4:reasoning-high")).toBe("gpt-4");
  });

  it("handles a provider prefix combined with a thinking suffix", () => {
    expect(normalizeModelId("merge:deepseek/deepseek-v4-flash:thinking")).toBe("deepseek-v4-flash");
  });

  it("leaves already-clean ids untouched", () => {
    expect(normalizeModelId("deepseek-v4-flash")).toBe("deepseek-v4-flash");
    expect(normalizeModelId("claude-opus-4")).toBe("claude-opus-4");
  });

  it("does not let a version-tag strip swallow a trailing word", () => {
    expect(normalizeModelId("deepseek-v4-flash")).toBe("deepseek-v4-flash");
    expect(normalizeModelId("merge:gpt-5.6-luna")).toBe("gpt-5.6-luna");
  });

  it("still strips pure trailing version tags", () => {
    expect(normalizeModelId("some-model-v1")).toBe("some-model");
    expect(normalizeModelId("some-model-v1:0")).toBe("some-model");
  });

  it("still resolves the documented gateway/proxy shapes", () => {
    expect(normalizeModelId("playground-claude-opus-4-8")).toBe("claude-opus-4-8");
    expect(normalizeModelId("us.anthropic.claude-opus-4-7")).toBe("claude-opus-4-7");
  });
});

describe("lookupModelInfo", () => {
  const map = parseModelCatalog({
    anthropic: {
      models: {
        "claude-opus-4-8": { limit: { context: 1000000 }, cost: { input: 5, output: 25 } },
      },
    },
    openai: { models: { "gpt-5": { limit: { context: 400000 }, tool_call: true } } },
  });

  it("matches exact ids", () => {
    expect(lookupModelInfo(map, "gpt-5")?.context).toBe(400000);
  });

  it("matches proxy/gateway prefixes", () => {
    expect(lookupModelInfo(map, "playground-claude-opus-4-8")?.context).toBe(1000000);
    expect(lookupModelInfo(map, "us.anthropic.claude-opus-4-8")?.context).toBe(1000000);
    expect(lookupModelInfo(map, "merge:anthropic/claude-opus-4-8")?.context).toBe(1000000);
  });

  it("matches version-separator variants", () => {
    expect(lookupModelInfo(map, "claude-opus-4.8")?.context).toBe(1000000);
  });

  it("returns null for unknown ids", () => {
    expect(lookupModelInfo(map, "definitely-not-a-model")).toBeNull();
    expect(lookupModelInfo({}, "gpt-5")).toBeNull();
  });
});

describe("formatModelCost", () => {
  it("renders a compact in/out label", () => {
    expect(formatModelCost(1.25, 10)).toBe("$1.25/$10");
  });

  it("keeps significant digits for tiny prices", () => {
    expect(formatModelCost(0.0008, 0.0024)).toBe("$0.0008/$0.0024");
  });

  it("renders 'free' when both are zero", () => {
    expect(formatModelCost(0, 0)).toBe("free");
  });

  it("treats a missing side as zero", () => {
    expect(formatModelCost(null, 2)).toBe("$0/$2");
    expect(formatModelCost(3, null)).toBe("$3/$0");
  });

  it("returns null when nothing is known", () => {
    expect(formatModelCost(null, null)).toBeNull();
  });

  it("formats negatives", () => {
    expect(formatModelCost(-0.5, 1)).toBe("-$0.5/$1");
  });
});

describe("providerLogoUrl", () => {
  it("points at the models.dev logo endpoint", () => {
    expect(providerLogoUrl("anthropic")).toBe("https://models.dev/logos/anthropic.svg");
  });
});
