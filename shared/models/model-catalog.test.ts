/**
 * Unit tests for the shared models.dev catalog helpers: parsing, model-id
 * normalization, fuzzy lookup, and per-1M cost formatting.
 */

import { describe, expect, it } from "vitest";
import {
  formatModelCost,
  logoProviderFor,
  endpointLogoSlug,
  lookupModelInfo,
  modelInputChips,
  normalizeModelId,
  normalizeModelInfo,
  canonicalProviderFor,
  parseCanonicalCatalog,
  parseModelCatalog,
  providerLogoUrl,
  providerLogoUrlFor,
  supportsImageInput,
  resolveMaxOutputTokens,
  positiveTokenLimit,
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
            reasoning: true,
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
      maxOutput: 128000,
      input: 1.25,
      output: 10,
      cacheRead: null,
      cacheWrite: null,
      modes: ["text", "image", "pdf"],
      toolCall: true,
      reasoning: true,
      provider: "openai",
    });
    expect(map["claude-4"]).toEqual({
      context: 1000000,
      maxOutput: null,
      input: null,
      output: null,
      cacheRead: null,
      cacheWrite: null,
      modes: [],
      toolCall: null,
      reasoning: null,
      provider: "anthropic",
    });
  });

  it("tolerates missing/odd fields", () => {
    const map = parseModelCatalog({
      deepseek: { models: { "deepseek-v4-flash": { limit: { context: "n/a" }, tool_call: "yes" } } },
    });
    expect(map["deepseek-v4-flash"]).toEqual({
      context: null,
      maxOutput: null,
      input: null,
      output: null,
      cacheRead: null,
      cacheWrite: null,
      modes: [],
      toolCall: null,
      reasoning: null,
      provider: "deepseek",
    });
  });

  it("returns an empty map for junk input", () => {
    expect(parseModelCatalog(null)).toEqual({});
    expect(parseModelCatalog("nope")).toEqual({});
  });

  it("coerces a zero/negative limit.output to null (models.dev has real output:0 entries)", () => {
    const map = parseModelCatalog({
      p: {
        models: {
          zero: { limit: { context: 8000, output: 0 } },
          neg: { limit: { context: 8000, output: -1 } },
          ok: { limit: { context: 8000, output: 4096 } },
        },
      },
    });
    expect(map["zero"].maxOutput).toBeNull();
    expect(map["neg"].maxOutput).toBeNull();
    expect(map["ok"].maxOutput).toBe(4096);
  });
});

describe("positiveTokenLimit", () => {
  it("accepts positive integers, floors fractions, rejects the rest", () => {
    expect(positiveTokenLimit(4096)).toBe(4096);
    expect(positiveTokenLimit(4096.9)).toBe(4096);
    expect(positiveTokenLimit(1)).toBe(1);
    expect(positiveTokenLimit(0)).toBeNull();
    expect(positiveTokenLimit(0.5)).toBeNull();
    expect(positiveTokenLimit(-10)).toBeNull();
    expect(positiveTokenLimit(Number.NaN)).toBeNull();
    expect(positiveTokenLimit("4096")).toBeNull();
    expect(positiveTokenLimit(null)).toBeNull();
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

  it("never crashes on legacy entries missing `modes`", () => {
    expect(supportsImageInput({ image: true } as never)).toBe(false);
    expect(supportsImageInput({} as never)).toBe(false);
  });
});

describe("resolveMaxOutputTokens", () => {
  it("omits (returns undefined) by default so the model finishes naturally", () => {
    // The correct default: send no cap → provider runs to finish_reason:"stop"
    // with full reasoning + answer. A cap only ever truncates the tail case.
    expect(resolveMaxOutputTokens()).toBeUndefined();
    expect(resolveMaxOutputTokens(undefined)).toBeUndefined();
    expect(resolveMaxOutputTokens(null)).toBeUndefined();
  });

  it("sends a user override >= 1 verbatim (deliberate cost/latency cap), floored", () => {
    expect(resolveMaxOutputTokens(5000)).toBe(5000);
    expect(resolveMaxOutputTokens(200.9)).toBe(200); // floored
    expect(resolveMaxOutputTokens(1)).toBe(1);
    expect(resolveMaxOutputTokens(384000)).toBe(384000);
  });

  it("ignores non-positive / non-finite overrides and omits the field", () => {
    expect(resolveMaxOutputTokens(0)).toBeUndefined();
    expect(resolveMaxOutputTokens(-5)).toBeUndefined();
    expect(resolveMaxOutputTokens(Number.NaN)).toBeUndefined();
  });

  it("omits rather than sending max_tokens:0 for a fractional override in (0,1)", () => {
    // Regression: `> 0` then Math.floor turned 0.1 / 0.999 into 0 — a broken cap.
    expect(resolveMaxOutputTokens(0.1)).toBeUndefined();
    expect(resolveMaxOutputTokens(0.999)).toBeUndefined();
  });
});

describe("normalizeModelInfo", () => {
  it("passes well-formed entries through unchanged", () => {
    const info = { context: 1000, maxOutput: 8000, input: 1, output: 2, cacheRead: 3, cacheWrite: 4, modes: ["text"], toolCall: true, reasoning: true, provider: "x" };
    expect(normalizeModelInfo(info as never)).toEqual(info);
  });

  it("defaults cacheRead/cacheWrite to null when a legacy cache entry lacks them", () => {
    const legacy = { context: 1000, input: 1, output: 2, modes: ["text"], toolCall: true, provider: "x" };
    const norm = normalizeModelInfo(legacy as never);
    expect(norm?.cacheRead).toBeNull();
    expect(norm?.cacheWrite).toBeNull();
  });

  it("defaults maxOutput to null when a legacy cache entry lacks it", () => {
    const legacy = { context: 1000, input: 1, output: 2, modes: ["text"], toolCall: true, provider: "x" };
    expect(normalizeModelInfo(legacy as never)?.maxOutput).toBeNull();
  });

  it("migrates the legacy pre-`modes` image boolean", () => {
    const withImage = normalizeModelInfo({ context: 10, image: true } as never);
    expect(withImage?.modes).toEqual(["text", "image"]);
    const noImage = normalizeModelInfo({ context: 10, image: false } as never);
    expect(noImage?.modes).toEqual(["text"]);
  });

  it("fills missing modes and returns null for junk", () => {
    expect(normalizeModelInfo({ context: 10 } as never)?.modes).toEqual([]);
    expect(normalizeModelInfo(null)).toBeNull();
    expect(normalizeModelInfo("nope" as never)).toBeNull();
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

describe("endpointLogoSlug", () => {
  it("resolves a direct-vendor hostname to a models.dev slug", () => {
    expect(endpointLogoSlug("https://api.openai.com/v1")).toBe("openai");
    expect(endpointLogoSlug("https://api.together.ai/v1")).toBe("together");
    expect(endpointLogoSlug("https://api.groq.com/openai/v1")).toBe("groq");
    expect(endpointLogoSlug("https://api.deepseek.com")).toBe("deepseek");
    expect(endpointLogoSlug("https://api.neuralwatt.com/v1")).toBe("neuralwatt");
  });

  it("handles a bare host without a scheme", () => {
    expect(endpointLogoSlug("api.openai.com/v1")).toBe("openai");
  });

  it("returns null for unknown hostnames or junk", () => {
    expect(endpointLogoSlug("https://my-localhost-server:1234/v1")).toBeNull();
    expect(endpointLogoSlug("")).toBeNull();
    expect(endpointLogoSlug("   ")).toBeNull();
  });
});

describe("logoProviderFor", () => {
  // models.dev lists each model under every host provider; the catalog's
  // `provider` is whoever got flattened first (e.g. "hpc-ai" for a DeepSeek
  // model). The logo must follow the model's own brand, not that arbitrary host.
  it("prefers a leading provider token in the id over the catalog host", () => {
    expect(logoProviderFor("deepseek/deepseek-v4-flash", "hpc-ai")).toBe("deepseek");
    expect(logoProviderFor("openai/gpt-5.2", "perplexity-agent")).toBe("openai");
    expect(logoProviderFor("~anthropic/claude-opus-4", "cloudflare-ai-gateway")).toBe("anthropic");
  });

  it("resolves bare brand ids even when the catalog has no entry", () => {
    expect(logoProviderFor("deepseek-v4-flash", "cortecs")).toBe("deepseek");
    expect(logoProviderFor("gpt-5.2-mini", null)).toBe("openai");
    expect(logoProviderFor("gemma-3", null)).toBe("google");
    expect(logoProviderFor("claude-opus-4", null)).toBe("anthropic");
    expect(logoProviderFor("qwen2.5", null)).toBe("alibaba");
  });

  it("matches the brand on the last path segment of gateway ids", () => {
    expect(logoProviderFor("accounts/fireworks/models/deepseek-v4-flash", "fireworks-ai")).toBe("deepseek");
    expect(logoProviderFor("empiriolabs/deepseek-v4-flash-el", "poe")).toBe("deepseek");
  });

  it("falls back to the catalog provider for unbranded ids", () => {
    expect(logoProviderFor("some-host-variant", "hpc-ai")).toBe("hpc-ai");
    expect(logoProviderFor("unknown-model-xyz", null)).toBeNull();
  });

  it("matches brand prefixes regardless of casing", () => {
    expect(logoProviderFor("Anthropic/Claude-Opus-4", "cloudflare-ai-gateway")).toBe("anthropic");
    expect(logoProviderFor("OpenAI/GPT-5.2", "perplexity-agent")).toBe("openai");
    expect(logoProviderFor("DeepSeek-V4-Flash", "cortecs")).toBe("deepseek");
    expect(logoProviderFor("accounts/Fireworks/Models/DeepSeek-v4-flash", "fireworks-ai")).toBe("deepseek");
  });

  it("providerLogoUrlFor composes the model-resolved URL", () => {
    expect(providerLogoUrlFor("deepseek/deepseek-v4-flash", "hpc-ai")).toBe(
      "https://models.dev/logos/deepseek.svg",
    );
    expect(providerLogoUrlFor("unknown-model-xyz", null)).toBeNull();
  });
});

describe("parseCanonicalCatalog / canonicalProviderFor", () => {
  // models.json keys models by canonical "<provider>/<model>" id; the leading
  // path segment names the OWNER (which api.json, with its duplicate entries,
  // can't tell us).
  const canonical = parseCanonicalCatalog({
    "deepseek/deepseek-v4-flash": { name: "DeepSeek V4 Flash" },
    "openai/gpt-5.2": { name: "GPT-5.2" },
    "zhipuai/glm-5": { name: "GLM-5" },
    "anthropic/claude-opus-4-6": { name: "Claude Opus 4.6" },
  });

  it("extracts the owner from the canonical id's leading path segment", () => {
    expect(Object.keys(canonical).length).toBe(4);
    expect(canonical["deepseek/deepseek-v4-flash"]).toBe("deepseek");
    expect(canonical["zhipuai/glm-5"]).toBe("zhipuai");
    expect(canonical["anthropic/claude-opus-4-6"]).toBe("anthropic");
  });

  it("ignores malformed entries without a provider path", () => {
    expect(parseCanonicalCatalog({ "no-path": {} })).toEqual({});
    expect(parseCanonicalCatalog(null)).toEqual({});
  });

  it("resolves exact canonical ids and normalized/fuzzy variants", () => {
    expect(canonicalProviderFor(canonical, "deepseek/deepseek-v4-flash")).toBe("deepseek");
    expect(canonicalProviderFor(canonical, "deepseek-v4-flash")).toBe("deepseek");
    expect(canonicalProviderFor(canonical, "~deepseek/deepseek-v4-flash-latest")).toBe("deepseek");
    expect(canonicalProviderFor(canonical, "zhipuai/glm-5")).toBe("zhipuai");
    expect(canonicalProviderFor(canonical, "glm-5")).toBe("zhipuai");
    expect(canonicalProviderFor(canonical, "gpt-5.2")).toBe("openai");
    expect(canonicalProviderFor(canonical, "not-a-real-model")).toBeNull();
  });

  it("prefers the canonical owner over the brand heuristic in logoProviderFor", () => {
    // GLM-5 has no heuristic entry, so without the canonical map it falls back
    // to the (arbitrary) catalog provider — with it, the owner wins.
    expect(logoProviderFor("glm-5", "some-host", canonical)).toBe("zhipuai");
    expect(logoProviderFor("glm-5", "some-host")).toBe("some-host");
    // deepseek agrees with the heuristic either way.
    expect(logoProviderFor("deepseek/deepseek-v4-flash", "hpc-ai", canonical)).toBe("deepseek");
    // Canonical ids that don't match still fall through to the heuristic.
    expect(logoProviderFor("claude-opus-4", null, canonical)).toBe("anthropic");
  });
});
