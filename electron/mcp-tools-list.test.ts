/**
 * The MCP `tools/list` response is what an external agent pays for on every
 * request, so it must carry the same trimmed schemas the in-app chat sends —
 * no `$schema` headers, regexes, bounds, defaults, or SDK `execution` blocks.
 */
import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildMcpServer } from "./mcp-server";
import { TOOL_SCHEMAS, CHAT_ONLY_TOOLS } from "./lib/tool-schemas";

async function listTools() {
  // tools/list never touches the workspace binding.
  const server = buildMcpServer({} as never);
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "test", version: "1" });
  await client.connect(clientSide);
  const { tools } = await client.listTools();
  await client.close();
  return tools;
}

describe("MCP tools/list", () => {
  it("advertises every Cairn tool except the chat-only ones", async () => {
    const names = (await listTools()).map((t) => t.name).sort();
    const expected = Object.keys(TOOL_SCHEMAS).filter((n) => !(CHAT_ONLY_TOOLS as string[]).includes(n)).sort();
    expect(names).toEqual(expected);
  });

  it("strips schema noise that costs tokens without guiding the model", async () => {
    const json = JSON.stringify(await listTools());
    for (const noise of ['"$schema"', '"pattern"', '"minimum"', '"maximum"', '"default"', '"execution"']) {
      expect(json, noise).not.toContain(noise);
    }
  });

  it("keeps required fields and parameter descriptions", async () => {
    const searchNotes = (await listTools()).find((t) => t.name === "search_notes")!;
    expect(searchNotes.inputSchema.required).toEqual(["query"]);
    expect(JSON.stringify(searchNotes.inputSchema)).toContain("Pagination offset");
  });
});
