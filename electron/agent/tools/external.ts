/** User-configured MCP servers and custom HTTP services, exposed as `mcp__<id>__*` / `svc__*` tools. */
import type Database from "better-sqlite3";
import { createHostStore } from "../host-store";
import { approvalPreview } from "../../../shared/agent/tool-risk";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentTool } from "../tools";
import { fail, fromJsonSchema, renderValue } from "./schema";

export interface ExternalToolDeps {
  db: Database.Database;
  workspaceId: string;
  projectId: string;
}

export async function externalTools(deps: ExternalToolDeps): Promise<AgentTool[]> {
  const store = createHostStore(deps.db);
  const defs = (await store.getExternalToolDefs(deps.workspaceId, deps.projectId)) as Array<{ function: { name: string; description: string; parameters: Record<string, unknown> } }>;
  return defs.map(({ function: { name, description, parameters } }) => defineTool({
    name,
    description,
    parameters: fromJsonSchema(parameters),
    // Leaves the device through a connected service; asks unless a rule (e.g. `mcp__github__*`) allows it.
    risk: () => ({ class: "EXTERNAL" }),
    preview: (args) => approvalPreview(name, args),
    async execute(args, ctx) {
      try {
        return { content: renderValue(await store.executeExternalTool(deps.workspaceId, deps.projectId, name, args as Record<string, unknown>, ctx.signal)) };
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  }));
}

const MAX_INSTRUCTION_BYTES = 4_000;

function truncateUtf8(text: string, max: number): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.byteLength <= max) return text;
  return `${bytes.subarray(0, max).toString("utf8").replace(/�$/, "")}\n[…instructions truncated]`;
}

/**
 * What in-scope MCP servers publish beyond tools: their `initialize` instructions (for the system
 * prompt) and, for servers that serve resources, the shared resource tools.
 */
export async function externalExtras(deps: ExternalToolDeps): Promise<{ tools: AgentTool[]; instructions: string }> {
  const store = createHostStore(deps.db);
  const servers = await store.getExternalMcpServerMeta(deps.workspaceId, deps.projectId);
  const withResources = servers.filter((s) => s.resources);
  const instructions = servers
    .filter((s) => s.instructions)
    .map((s) => `### MCP server: ${s.name} (tools named mcp__${s.id}__*)\n\n${truncateUtf8(s.instructions!, MAX_INSTRUCTION_BYTES)}`)
    .join("\n\n");
  if (!withResources.length) return { tools: [], instructions };
  const ids = withResources.map((s) => s.id);
  const request = async (server: string, req: Parameters<typeof store.requestExternalMcpResource>[3], signal?: AbortSignal) => {
    if (!ids.includes(server)) return fail(`No MCP server "${server}" serves resources. Available: ${ids.join(", ")}.`);
    try {
      return { content: renderValue(await store.requestExternalMcpResource(deps.workspaceId, deps.projectId, server, req, signal)) };
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  };
  const risk = () => ({ class: "EXTERNAL" as const });
  const serverParam = Type.String({ description: `MCP server id (${ids.join(", ")}).` });
  return {
    instructions,
    tools: [
      defineTool({
        name: "list_mcp_resources",
        description: "List the resources an MCP server offers.",
        parameters: Type.Object({ server: serverParam, cursor: Type.Optional(Type.String()) }),
        risk,
        execute: (a, ctx) => request(a.server, { method: "resources/list", cursor: a.cursor }, ctx.signal),
      }),
      defineTool({
        name: "list_mcp_resource_templates",
        description: "List the resource templates an MCP server offers.",
        parameters: Type.Object({ server: serverParam, cursor: Type.Optional(Type.String()) }),
        risk,
        execute: (a, ctx) => request(a.server, { method: "resources/templates/list", cursor: a.cursor }, ctx.signal),
      }),
      defineTool({
        name: "read_mcp_resource",
        description: "Read one resource from an MCP server by URI.",
        parameters: Type.Object({ server: serverParam, uri: Type.String() }),
        risk,
        execute: (a, ctx) => request(a.server, { method: "resources/read", uri: a.uri }, ctx.signal),
      }),
    ],
  };
}
