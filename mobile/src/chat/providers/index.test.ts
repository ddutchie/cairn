/**
 * OpenCode serves each model over one protocol, so provider selection follows
 * the model (models.dev), not a per-endpoint probe. Other endpoints keep the
 * probe. Native/provider modules are mocked so the real selection logic runs.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  config: { baseUrl: "https://opencode.ai/zen/go/v1", model: "m", apiKey: "k" },
  protocol: vi.fn(),
  supportsResponses: vi.fn(async () => false),
}));
vi.mock("../ai-config", () => ({ getProviderPref: () => "openai", resolveOpenAIConfig: async () => h.config }));
vi.mock("./apple", () => ({
  appleProvider: {}, appleOnDeviceProvider: {},
  isAppleOnDeviceAvailable: () => false, isAppleServerProviderAvailable: () => false,
}));
vi.mock("./openai", () => ({ makeOpenAIProvider: () => ({ name: "completions" }) }));
vi.mock("./responses", () => ({ makeResponsesProvider: () => ({ name: "responses" }), supportsResponses: h.supportsResponses }));
vi.mock("../models-dev", () => ({ endpointProtocolForModel: h.protocol }));
vi.mock("../ai-consent", () => ({ ensureAiConsent: async () => {} }));

const { resolveProvider, UnsupportedModelProtocolError } = await import("./index");

beforeEach(() => {
  h.protocol.mockReset();
  h.supportsResponses.mockClear();
});

describe("resolveProvider on an endpoint that dictates the protocol", () => {
  it("uses Responses for a Responses-only model, without probing", async () => {
    h.protocol.mockResolvedValue("responses");
    expect((await resolveProvider()).name).toBe("responses");
    expect(h.supportsResponses).not.toHaveBeenCalled();
  });

  it("uses Chat Completions for a default-protocol model, without probing", async () => {
    h.protocol.mockResolvedValue("completions");
    expect((await resolveProvider()).name).toBe("completions");
    expect(h.supportsResponses).not.toHaveBeenCalled();
  });

  it("explains an Anthropic-only model instead of sending a request that 400s", async () => {
    h.protocol.mockResolvedValue("anthropic-messages");
    await expect(resolveProvider()).rejects.toBeInstanceOf(UnsupportedModelProtocolError);
    await expect(resolveProvider()).rejects.toThrow(/Anthropic Messages/);
  });

  it("falls back to the probe when the endpoint doesn't dictate one", async () => {
    h.protocol.mockResolvedValue(null);
    h.supportsResponses.mockResolvedValueOnce(true);
    expect((await resolveProvider()).name).toBe("responses");
    expect(h.supportsResponses).toHaveBeenCalledOnce();
  });
});
