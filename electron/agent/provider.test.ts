import { describe, expect, it } from "vitest";
import { buildModel, createRouteStream, reasoningOption, supportedThinkingLevels, type ModelRoute } from "./provider";

const route = (over: Partial<ModelRoute> = {}): ModelRoute => ({
  baseUrl: "http://localhost:3042/v1", model: "m", api: "openai-completions", ...over,
});

describe("buildModel", () => {
  it("applies Cairn defaults", () => {
    const m = buildModel(route());
    expect(m).toMatchObject({
      id: "m", provider: "cairn", api: "openai-completions", baseUrl: "http://localhost:3042/v1",
      contextWindow: 128_000, maxTokens: 32_768, reasoning: false, input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    });
    expect(m.thinkingLevelMap).toBeUndefined();
  });

  it("carries explicit limits and headers", () => {
    const m = buildModel(route({ contextWindow: 1000, maxTokens: 10, headers: { "User-Agent": "cairn/1" } }));
    expect(m).toMatchObject({ contextWindow: 1000, maxTokens: 10, headers: { "User-Agent": "cairn/1" } });
  });
});

describe("thinking levels", () => {
  it("a non-reasoning model only offers off", () => {
    expect(supportedThinkingLevels(buildModel(route()))).toEqual(["off"]);
  });

  it("a reasoning completions model offers off + low/medium/high", () => {
    expect(supportedThinkingLevels(buildModel(route({ reasoning: true })))).toEqual(["off", "low", "medium", "high"]);
  });

  it("a reasoning Responses model does not offer off (pi-ai would send effort:none)", () => {
    const m = buildModel(route({ api: "openai-responses", reasoning: true }));
    expect(m.thinkingLevelMap?.off).toBeNull();
    expect(supportedThinkingLevels(m)).toEqual(["low", "medium", "high"]);
  });

  it("anthropic routes get the same table as completions", () => {
    expect(supportedThinkingLevels(buildModel(route({ api: "anthropic-messages", reasoning: true })))).toEqual(["off", "low", "medium", "high"]);
  });
});

describe("reasoningOption", () => {
  const completions = buildModel(route({ reasoning: true }));
  const responses = buildModel(route({ api: "openai-responses", reasoning: true }));

  it("passes through offered efforts", () => {
    expect(reasoningOption(completions, "medium")).toBe("medium");
    expect(reasoningOption(responses, "high")).toBe("high");
  });

  it("treats off and unset as no reasoning, on every api", () => {
    for (const m of [completions, responses]) {
      expect(reasoningOption(m, "off")).toBeUndefined();
      expect(reasoningOption(m, undefined)).toBeUndefined();
    }
  });

  it("clamps an unoffered effort to the nearest lower offered level", () => {
    expect(reasoningOption(completions, "xhigh")).toBe("high");
    expect(reasoningOption(completions, "max")).toBe("high");
    expect(reasoningOption(completions, "minimal")).toBe("low");
  });

  it("never requests reasoning from a non-reasoning model or for junk", () => {
    expect(reasoningOption(buildModel(route()), "high")).toBeUndefined();
    expect(reasoningOption(completions, "turbo")).toBeUndefined();
  });
});

describe("createRouteStream", () => {
  it.each(["openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai"] as const)(
    "builds a stream for %s", (api) => {
      const { model, streamFn } = createRouteStream(route({ api }));
      expect(model.api).toBe(api);
      expect(typeof streamFn).toBe("function");
    });

  it("rejects an unknown protocol", () => {
    expect(() => createRouteStream(route({ api: "carrier-pigeon" as never }))).toThrow(/Unsupported wire protocol/);
  });
});
