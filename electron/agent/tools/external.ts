/** User-configured MCP servers and custom HTTP services, exposed as `mcp__<id>__*` / `svc__*` tools. */
import type Database from "better-sqlite3";
import { createHostStore } from "../../cordis/host-store";
import { approvalPreview } from "../../../shared/agent/tool-risk";
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
    async execute(args) {
      try {
        return { content: renderValue(await store.executeExternalTool(deps.workspaceId, deps.projectId, name, args as Record<string, unknown>)) };
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  }));
}
