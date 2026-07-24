import { describe, it, expect } from "vitest";
import {
  namespaceToolName,
  parseToolName,
  isMcpToolName,
  mcpToolsToOpenAI,
  stringifyToolResult,
} from "./mcp-namespace";

describe("mcp namespacing", () => {
  it("namespaces a tool name", () => {
    expect(namespaceToolName("srv1", "search")).toBe("mcp__srv1__search");
  });

  it("round-trips namespace ↔ parse", () => {
    const ns = namespaceToolName("github", "create_issue");
    expect(parseToolName(ns)).toEqual({ serverId: "github", toolName: "create_issue" });
  });

  it("parses a tool name whose own name contains the separator", () => {
    const ns = namespaceToolName("srv1", "weird__tool__name");
    expect(parseToolName(ns)).toEqual({ serverId: "srv1", toolName: "weird__tool__name" });
  });

  it("returns null for non-MCP names", () => {
    expect(parseToolName("read")).toBeNull();
    expect(parseToolName("svc__service1__call")).toBeNull(); // service prefix, not mcp
  });

  it("returns null for malformed namespaced names", () => {
    expect(parseToolName("mcp__")).toBeNull();
    expect(parseToolName("mcp__srv1__")).toBeNull(); // empty tool name
    expect(parseToolName("mcp____tool")).toBeNull(); // empty server id
  });

  it("isMcpToolName distinguishes sources", () => {
    expect(isMcpToolName("mcp__srv1__search")).toBe(true);
    expect(isMcpToolName("svc__s1__call")).toBe(false);
    expect(isMcpToolName("read")).toBe(false);
  });
});

describe("mcp def conversion", () => {
  it("converts MCP tool defs to namespaced OpenAI defs", () => {
    const defs = mcpToolsToOpenAI("srv1", [
      { name: "search", description: "Search things", inputSchema: { type: "object", properties: { q: { type: "string" } } } },
    ]);
    expect(defs).toEqual([
      {
        type: "function",
        function: {
          name: "mcp__srv1__search",
          description: "Search things",
          parameters: { type: "object", properties: { q: { type: "string" } } },
        },
      },
    ]);
  });

  it("supplies an empty object schema + description for sparse defs", () => {
    const defs = mcpToolsToOpenAI("srv1", [{ name: "ping" }]);
    expect(defs[0].function.description).toBe("");
    expect(defs[0].function.parameters).toEqual({ type: "object", properties: {} });
  });
});

describe("stringifyToolResult", () => {
  it("concatenates text content parts", () => {
    expect(stringifyToolResult({ content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] })).toBe("a\nb");
  });

  it("prefixes error results", () => {
    expect(stringifyToolResult({ content: [{ type: "text", text: "boom" }], isError: true })).toBe("Error: boom");
  });

  it("JSON-stringifies non-text parts", () => {
    const out = stringifyToolResult({ content: [{ type: "image", data: "xyz" } as never] });
    expect(out).toContain("image");
  });

  it("falls back to JSON for a non-standard shape", () => {
    expect(stringifyToolResult({ weird: true })).toBe(JSON.stringify({ weird: true }));
  });
});
