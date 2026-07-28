import { describe, it, expect, vi } from "vitest";

// `./tokens` pulls in js-tiktoken (a mobile-only dependency, absent from the
// root node_modules that this vitest project resolves against on CI). These
// tests only assert token counts are >0 / ===0, never exact values, so a
// framework-free chars/4 estimate is a faithful stand-in and keeps the mobile
// vitest project dependency-free as intended (see vitest.config.ts).
vi.mock("./tokens", () => ({
  countTextTokens: (text: string) => (text ? Math.ceil(text.length / 4) : 0),
}));

import {
  computeBreakdown,
  scaleBreakdown,
  breakdownTotal,
  type TokenBreakdown,
} from "./token-breakdown";
import type { UIMessage } from "./providers/types";

const tools = {
  get_cairn_context: { description: "Get the workspace context", jsonSchema: {} },
  mcp__srv__read_file: { description: "Read a file from the MCP server", jsonSchema: {} },
  svc__weather__current: { description: "Current weather for a city", jsonSchema: {} },
};

describe("computeBreakdown", () => {
  const messages: UIMessage[] = [
    { id: "s", role: "system", parts: [{ type: "text", text: "You are the assistant." }] },
    { id: "u", role: "user", parts: [{ type: "text", text: "hello there" }] },
    {
      id: "a",
      role: "assistant",
      parts: [
        { type: "text", text: "Working on it." },
        {
          type: "tool-get_cairn_context",
          toolCallId: "c1",
          toolName: "get_cairn_context",
          state: "output-available",
          input: { a: 1 },
          output: { type: "text", value: "a long tool result payload here" },
        },
      ],
    },
  ];

  it("splits external (MCP + service) tool defs from built-in tools", () => {
    const b = computeBreakdown(messages, tools);
    // Two external defs (mcp__ + svc__) → mcp; one built-in → tools.
    expect(b.mcp).toBeGreaterThan(0);
    expect(b.tools).toBeGreaterThan(0);
  });

  it("counts the system prompt separately from conversation", () => {
    const b = computeBreakdown(messages, tools);
    expect(b.systemPrompt).toBeGreaterThan(0);
    expect(b.conversation).toBeGreaterThan(0);
  });

  it("counts tool call inputs and outputs under toolOutputs", () => {
    const b = computeBreakdown(messages, tools);
    expect(b.toolOutputs).toBeGreaterThan(0);
  });

  it("leaves mobile-unused categories at zero", () => {
    const b = computeBreakdown(messages, tools);
    expect(b.skills).toBe(0);
    expect(b.rules).toBe(0);
    expect(b.subagentDefinitions).toBe(0);
  });

  it("returns all-zero for empty input", () => {
    const b = computeBreakdown([], {});
    expect(breakdownTotal(b)).toBe(0);
  });
});

describe("scaleBreakdown", () => {
  const base: TokenBreakdown = {
    systemPrompt: 10,
    skills: 0,
    tools: 20,
    conversation: 30,
    toolOutputs: 40,
    rules: 0,
    mcp: 0,
    subagentDefinitions: 0,
  };

  it("rescales so the categories sum to the target total", () => {
    const scaled = scaleBreakdown(base, 200); // base sums to 100 → ×2
    expect(breakdownTotal(scaled)).toBe(200);
    expect(scaled.toolOutputs).toBe(80);
  });

  it("is a no-op when the target total is non-positive", () => {
    expect(scaleBreakdown(base, 0)).toEqual(base);
    expect(scaleBreakdown(base, -5)).toEqual(base);
  });

  it("is a no-op when the breakdown sums to zero", () => {
    const zero: TokenBreakdown = {
      systemPrompt: 0, skills: 0, tools: 0, conversation: 0,
      toolOutputs: 0, rules: 0, mcp: 0, subagentDefinitions: 0,
    };
    expect(scaleBreakdown(zero, 500)).toEqual(zero);
  });
});
