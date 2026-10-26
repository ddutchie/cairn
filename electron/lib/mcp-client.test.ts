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
  testConnection,
  captureStderrTail,
  withStderr,
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

describe("mcp-client stdio test connection", () => {
  it("surfaces the child's stderr when it exits before the handshake", async () => {
    const r = await testConnection({
      id: "dies",
      name: "dies",
      transport: "stdio",
      command: process.execPath,
      args: ["-e", "console.error('Consent Failed: WAM Error'); process.exit(1)"],
    } as Parameters<typeof testConnection>[0]);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("Connection closed");
    expect(r.error).toContain("server stderr");
    expect(r.error).toContain("Consent Failed: WAM Error");
  });

  it("keeps the plain error when stderr is empty", async () => {
    const r = await testConnection({
      id: "silent",
      name: "silent",
      transport: "stdio",
      command: process.execPath,
      args: ["-e", "process.exit(1)"],
    } as Parameters<typeof testConnection>[0]);
    expect(r.ok).toBe(false);
    expect(r.error).not.toContain("server stderr");
  });
});

describe("withStderr", () => {
  it("appends the tail to the message", () => {
    const e = withStderr(new Error("boom"), "line1\nline2");
    expect(e.message).toBe("boom\n--- server stderr ---\nline1\nline2");
    expect(withStderr(new Error("x"), "").message).toBe("x");
  });
});

describe("captureStderrTail", () => {
  function feed(chunks: Array<Buffer | string>): string {
    let cb: ((chunk: Buffer | string) => void) | null = null;
    const tail = captureStderrTail({ on: (_e: "data", fn: (c: Buffer | string) => void) => { cb = fn; } });
    for (const c of chunks) cb!(c);
    return tail();
  }

  it("keeps multi-byte UTF-8 split across chunks intact", () => {
    // "é" is 2 bytes in UTF-8; split it across two chunks.
    const bytes = Buffer.from("caf\u00e9", "utf8");
    expect(feed([bytes.subarray(0, 3), bytes.subarray(3)])).toBe("caf\u00e9");
  });

  it("keeps only the tail and trims", () => {
    expect(feed(["  abcdef  "])).toBe("abcdef");
  });
});
