/**
 * A local stdio MCP server is spawned, listed and called through the same
 * client the remote servers use (the agent engine's only MCP path).
 */
import { describe, it, expect, afterAll } from "vitest";
import * as mcpClient from "./mcp-client";

const SERVER = `
const { McpServer } = require(${JSON.stringify(require.resolve("@modelcontextprotocol/sdk/server/mcp.js"))});
const { StdioServerTransport } = require(${JSON.stringify(require.resolve("@modelcontextprotocol/sdk/server/stdio.js"))});
const { z } = require(${JSON.stringify(require.resolve("zod"))});
const s = new McpServer({ name: "echo", version: "1.0.0" });
s.tool("shout", "Upper-case text", { text: z.string() }, async ({ text }) => ({ content: [{ type: "text", text: text.toUpperCase() }] }));
s.connect(new StdioServerTransport());
`;

const cfg = { id: "echo", transport: "stdio" as const, command: process.execPath, args: ["-e", SERVER], env: { ELECTRON_RUN_AS_NODE: "1" } };

describe("stdio MCP servers", () => {
  afterAll(() => mcpClient.disposeAll());

  it("lists and calls tools over a persistent stdio connection", async () => {
    const defs = await mcpClient.listTools(cfg);
    expect(defs.map((d) => d.function.name)).toEqual(["mcp__echo__shout"]);
    const out = await mcpClient.callTool(cfg, "mcp__echo__shout", { text: "hi" });
    expect(out).toContain("HI");
  }, 30_000);
});
