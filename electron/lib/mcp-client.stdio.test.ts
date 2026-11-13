/**
 * A local stdio MCP server is spawned, listed and called through the same
 * client the remote servers use (the agent engine's only MCP path).
 */
import { describe, it, expect, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import * as mcpClient from "./mcp-client";

const SERVER = `
const { McpServer } = require(${JSON.stringify(require.resolve("@modelcontextprotocol/sdk/server/mcp.js"))});
const { StdioServerTransport } = require(${JSON.stringify(require.resolve("@modelcontextprotocol/sdk/server/stdio.js"))});
const { z } = require(${JSON.stringify(require.resolve("zod"))});
const s = new McpServer({ name: "echo", version: "1.0.0" });
s.tool("shout", "Upper-case text", { text: z.string() }, async ({ text }) => ({ content: [{ type: "text", text: text.toUpperCase() }] }));
// Waits \`ms\`, optionally reporting progress every \`tick\` ms; writes \`marker\` if the client cancels the call.
s.tool("slow", "Slow work", { ms: z.number(), tick: z.number().optional(), marker: z.string().optional() }, async ({ ms, tick, marker }, extra) => {
  const token = extra._meta && extra._meta.progressToken;
  let n = 0;
  const timer = tick && token !== undefined ? setInterval(() => { extra.sendNotification({ method: "notifications/progress", params: { progressToken: token, progress: ++n } }); }, tick) : null;
  extra.signal.addEventListener("abort", () => { if (marker) require("fs").writeFileSync(marker, "cancelled"); });
  await new Promise((r) => setTimeout(r, ms));
  if (timer) clearInterval(timer);
  return { content: [{ type: "text", text: "finished" }] };
});
s.connect(new StdioServerTransport());
`;

const cfg = { id: "echo", transport: "stdio" as const, command: process.execPath, args: ["-e", SERVER], env: { ELECTRON_RUN_AS_NODE: "1" } };

describe("stdio MCP servers", () => {
  afterAll(() => mcpClient.disposeAll());

  it("lists and calls tools over a persistent stdio connection", async () => {
    const defs = await mcpClient.listTools(cfg);
    expect(defs.map((d) => d.function.name)).toEqual(["mcp__echo__shout", "mcp__echo__slow"]);
    const out = await mcpClient.callTool(cfg, "mcp__echo__shout", { text: "hi" });
    expect(out).toContain("HI");
  }, 30_000);

  it("cancels a call that passes the connector's timeout, and tells the server", async () => {
    const marker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mcp-timeout-")), "cancelled");
    const out = await mcpClient.callTool({ ...cfg, callTimeoutMs: 300 }, "mcp__echo__slow", { ms: 5_000, marker });
    expect(out).toMatch(/timed out after .*cancelled/);
    // The cancellation notification reaches the server shortly after.
    for (let i = 0; i < 40 && !fs.existsSync(marker); i++) await new Promise((r) => setTimeout(r, 50));
    expect(fs.existsSync(marker)).toBe(true);
  }, 30_000);

  it("keeps waiting while the server reports progress", async () => {
    const out = await mcpClient.callTool({ ...cfg, callTimeoutMs: 400 }, "mcp__echo__slow", { ms: 1_500, tick: 100 });
    expect(out).toContain("finished");
  }, 30_000);
});
