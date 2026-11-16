/**
 * B2 (F4) pinning test — records TODAY's output of the LLM connection resolvers
 * before they are unified into `lib/llm-config.ts`.
 *
 * Table cases (given a fixed cached snapshot; `resolveLlmApiKey` is identity):
 *   key present · key absent + cache same endpoint · key absent + cache other
 *   endpoint · local endpoint · mode vs autoApprove precedence · temperature 0.
 *
 * Commit 1 pins the legacy agent rule (cached key reused for ANY endpoint).
 * The Q2 unification (agent adopts the chat same-endpoint rule) flips the
 * marked row in its own commit.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { cachedConfig } = vi.hoisted(() => ({
  cachedConfig: { aiConfig: undefined as unknown, agentConfig: undefined as unknown },
}));

vi.mock("./config-cache", () => ({
  getCachedConfig: () => cachedConfig,
  cacheLlmConnection: vi.fn(),
}));
vi.mock("./secure-store", () => ({ resolveLlmApiKey: (ref?: string) => ref ?? "" }));

import { resolveConnection, resolveAgentLlmConfig, DEFAULT_LLM } from "./llm-config";

const AI_BASE = "https://api.openai.com";
const OTHER_BASE = "https://other.example.test";
const LOCAL_BASE = "http://localhost:11434";

function seedCache() {
  Object.assign(cachedConfig, {
    aiConfig: { provider: "openai", baseUrl: AI_BASE, model: "gpt-5.6-luna", apiKey: "CACHED_AI_KEY" },
    agentConfig: {
      baseUrl: AI_BASE, model: "gpt-5.6-luna", apiKey: "CACHED_AGENT_KEY",
      maxSteps: 20, temperature: 0.3, autoApprove: false, mode: "interactive",
    },
  });
}

beforeEach(() => {
  seedCache();
});

describe("DEFAULT_LLM", () => {
  it("is the OpenAI default endpoint + model", () => {
    expect(DEFAULT_LLM.baseUrl).toBe("https://api.openai.com");
    expect(DEFAULT_LLM.model).toBe("gpt-5.6-luna");
  });
});

describe("resolveConnection('ai') — chat rule", () => {
  const cases: Array<{
    name: string;
    req: { provider?: string; baseUrl?: string; model?: string; apiKey?: string } | undefined;
    expect: { provider: string; baseUrl: string; model: string; apiKey: string };
  }> = [
    {
      name: "key present: request wins wholesale",
      req: { provider: "openai", baseUrl: AI_BASE, model: "gpt-4o", apiKey: "REQ_KEY" },
      expect: { provider: "openai", baseUrl: AI_BASE, model: "gpt-4o", apiKey: "REQ_KEY" },
    },
    {
      name: "key absent + cache same endpoint: cached key reused",
      req: { baseUrl: AI_BASE, model: "gpt-4o" },
      expect: { provider: "openai", baseUrl: AI_BASE, model: "gpt-4o", apiKey: "CACHED_AI_KEY" },
    },
    {
      name: "key absent + empty request: inherits cached endpoint + key whole",
      req: {},
      expect: { provider: "openai", baseUrl: AI_BASE, model: "gpt-5.6-luna", apiKey: "CACHED_AI_KEY" },
    },
    {
      name: "key absent + cache other endpoint: cached key REFUSED",
      req: { baseUrl: OTHER_BASE, model: "m" },
      expect: { provider: "openai", baseUrl: OTHER_BASE, model: "m", apiKey: "" },
    },
    {
      name: "local endpoint, no key: allowed keyless",
      req: { baseUrl: LOCAL_BASE, model: "qwen3" },
      expect: { provider: "openai", baseUrl: LOCAL_BASE, model: "qwen3", apiKey: "" },
    },
    {
      name: "no request + empty cache: defaults, keyless",
      req: undefined,
      expect: { provider: "openai", baseUrl: AI_BASE, model: "gpt-5.6-luna", apiKey: "" },
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      if (c.name.startsWith("no request")) {
        Object.assign(cachedConfig, { aiConfig: undefined });
      }
      expect(resolveConnection("ai", c.req)).toEqual(c.expect);
    });
  }

  it("normalises a trailing-slash baseUrl", () => {
    expect(resolveConnection("ai", { baseUrl: `${AI_BASE}/`, model: "m", apiKey: "k" }).baseUrl).toBe(AI_BASE);
  });
});

describe("resolveConnection('agent') / resolveAgentLlmConfig — agent legacy rule", () => {
  it("key absent + cache other endpoint: cached key REFUSED (Q2 unified rule)", () => {
    const conn = resolveConnection("agent", { baseUrl: OTHER_BASE, model: "m" });
    expect(conn).toEqual({ provider: "openai", baseUrl: OTHER_BASE, model: "m", apiKey: "" });
    const { llmConfig } = resolveAgentLlmConfig({ baseUrl: OTHER_BASE, model: "m" });
    expect(llmConfig.apiKey).toBe("");
    expect(llmConfig.baseUrl).toBe(OTHER_BASE);
  });

  it("key absent + cache same endpoint: cached key reused, baseUrl/model inherited", () => {
    const { llmConfig } = resolveAgentLlmConfig({ model: "gpt-4o" });
    expect(llmConfig.baseUrl).toBe(AI_BASE);
    expect(llmConfig.model).toBe("gpt-4o");
    expect(llmConfig.apiKey).toBe("CACHED_AGENT_KEY");
  });

  it("key present: request wins", () => {
    const { llmConfig } = resolveAgentLlmConfig({ baseUrl: OTHER_BASE, model: "m", apiKey: "REQ_KEY" });
    expect(llmConfig).toMatchObject({ baseUrl: OTHER_BASE, model: "m", apiKey: "REQ_KEY" });
  });

  it("empty request + empty cache: defaults (compact-now shape)", () => {
    Object.assign(cachedConfig, { agentConfig: undefined });
    const { llmConfig, mode } = resolveAgentLlmConfig(undefined);
    expect(llmConfig).toMatchObject({
      baseUrl: "https://api.openai.com", model: "gpt-5.6-luna", apiKey: "", maxSteps: 20,
    });
    expect(mode).toBe("interactive");
  });

  it("temperature is renderer-authoritative: explicit 0 survives, unset stays omitted", () => {
    expect(resolveAgentLlmConfig({ temperature: 0 }).llmConfig.temperature).toBe(0);
    // Cached 0.3 is NOT back-filled.
    expect(resolveAgentLlmConfig({}).llmConfig.temperature).toBeUndefined();
    expect(resolveAgentLlmConfig({ temperature: 0.7 }).llmConfig.temperature).toBe(0.7);
  });

  const modeCases: Array<{
    name: string;
    req: { mode?: never; autoApprove?: boolean } | { mode: string; autoApprove?: boolean };
    cachedMode?: string;
    cachedAuto?: boolean;
    expect: string;
  }> = [
    { name: "explicit mode beats autoApprove=false", req: { mode: "auto", autoApprove: false }, expect: "auto" },
    { name: "explicit mode beats autoApprove=true", req: { mode: "plan", autoApprove: true }, expect: "plan" },
    { name: "autoApprove=true derives auto", req: { autoApprove: true }, expect: "auto" },
    { name: "autoApprove=false derives interactive", req: { autoApprove: false }, expect: "interactive" },
    { name: "neither: cached mode wins", req: {}, cachedMode: "auto", cachedAuto: false, expect: "auto" },
    { name: "neither, no cached mode: cached autoApprove wins", req: {}, cachedMode: undefined, cachedAuto: true, expect: "auto" },
    { name: "nothing anywhere: interactive default", req: {}, cachedMode: undefined, cachedAuto: undefined, expect: "interactive" },
    { name: "invalid mode string falls through to autoApprove", req: { mode: "bogus", autoApprove: true }, expect: "auto" },
  ];

  for (const c of modeCases) {
    it(`mode precedence — ${c.name}`, () => {
      Object.assign(cachedConfig, {
        agentConfig: {
          ...(cachedConfig.agentConfig as object),
          mode: c.cachedMode,
          autoApprove: c.cachedAuto,
        },
      });
      const { llmConfig, mode } = resolveAgentLlmConfig(c.req as never);
      expect(mode).toBe(c.expect);
      expect(llmConfig.mode).toBe(c.expect);
    });
  }
});
