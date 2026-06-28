import { describe, it, expect, vi } from "vitest";

// The module statically imports the SDK client transports + secure-store (which
// pulls in electron). Stub electron so the import graph resolves under Node; we
// only exercise the pure helpers here.
vi.mock("electron", () => ({
  app: { isReady: () => false, getPath: () => "/tmp" },
  safeStorage: { isEncryptionAvailable: () => false },
}));

import {
  namespaceToolName,
  parseToolName,
  isMcpToolName,
  mcpToolsToOpenAI,
} from "./mcp-client";

describe("mcp-client name namespacing", () => {
  it("namespaces a tool name", () => {
    expect(namespaceToolName("srv1", "search")).toBe("mcp__srv1__search");
  });

  it("round-trips namespace ↔ parse", () => {
    const ns = namespaceToolName("github", "create_issue");
    expect(parseToolName(ns)).toEqual({ serverId: "github", toolName: "create_issue" });
  });

  it("parses a tool name whose own name contains the separator", () => {
    // Only the FIRST separator splits serverId from toolName.
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

describe("mcp-client def conversion", () => {
  it("converts MCP tool defs to namespaced OpenAI defs", () => {
    const defs = mcpToolsToOpenAI("srv1", [
      {
        name: "search",
        description: "Search the web",
        inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
      },
    ]);
    expect(defs).toEqual([
      {
        type: "function",
        function: {
          name: "mcp__srv1__search",
          description: "Search the web",
          parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
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
