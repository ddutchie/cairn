/**
 * External tools integration seam — the single place the chat and agent loops
 * reach for "tools that aren't built in": remote MCP servers and custom HTTP
 * services.
 *
 * These are INBOUND tools consumed by Cairn's own LLM loops. They are
 * deliberately NOT registered into Cairn's outbound MCP server
 * (electron/mcp-server.ts), which only exposes Cairn's own data to external
 * clients.
 *
 * Scoping: a workspace-scoped tool is exposed to a given project's loop when
 *   (a) the tool's own config is `enabled`, AND
 *   (b) an attachment row enables it either globally (GLOBAL_TOOL_SCOPE) or for
 *       that specific project.
 *
 * Tool names are namespaced by the underlying executor (mcp__… / svc__…), so
 * routing on execution is a simple prefix check.
 */

import type Database from "better-sqlite3";
import * as q from "../db/queries";
import * as mcpClient from "./mcp-client";
import * as services from "./custom-services";

/** Mirrors GLOBAL_TOOL_SCOPE in src/types — electron cannot import from src. */
const GLOBAL_TOOL_SCOPE = "__global__";

export interface OpenAIToolDef {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

/** Map a stored MCP server config to the runtime config the client needs. */
function toRuntimeConfig(s: {
  id: string;
  baseUrl: string;
  transport: "sse" | "http";
  headers?: Record<string, string>;
  authMode?: "none" | "oauth";
  oauthScope?: string;
  name?: string;
}): mcpClient.McpServerRuntimeConfig {
  return {
    id: s.id,
    baseUrl: s.baseUrl,
    transport: s.transport,
    headers: s.headers,
    authMode: s.authMode,
    oauthScope: s.oauthScope,
    name: s.name,
  };
}

// ── Scoping (pure) ────────────────────────────────────────────────────────────

interface AttachmentRow {
  projectId: string;
  toolType: "mcp" | "service";
  toolId: string;
  enabled: boolean;
}

/**
 * Given the union of a project's own attachment rows and the global-scope rows,
 * return the set of tool ids (per type) that are attached + enabled for the
 * project. A row with `enabled === false` explicitly suppresses a tool even if
 * another row would enable it (project-level wins is unnecessary here — any
 * disabled row removes it).
 */
export function resolveAttachedToolIds(rows: AttachmentRow[]): {
  mcp: Set<string>;
  service: Set<string>;
} {
  const mcp = new Set<string>();
  const service = new Set<string>();
  const disabled = new Set<string>();

  for (const r of rows) {
    const key = `${r.toolType}:${r.toolId}`;
    if (!r.enabled) {
      disabled.add(key);
      continue;
    }
    if (r.toolType === "mcp") mcp.add(r.toolId);
    else service.add(r.toolId);
  }
  // Honour explicit disables (e.g. global-on but project-off).
  for (const key of disabled) {
    const [type, id] = key.split(":");
    if (type === "mcp") mcp.delete(id);
    else service.delete(id);
  }
  return { mcp, service };
}

// ── Def assembly ──────────────────────────────────────────────────────────────

/** Load the in-scope MCP + service runtime configs for a project. */
function loadScopedConfigs(db: Database.Database, workspaceId: string, projectId: string) {
  const rows = [
    ...q.getToolAttachments(db, GLOBAL_TOOL_SCOPE),
    ...(projectId ? q.getToolAttachments(db, projectId) : []),
  ] as AttachmentRow[];
  const attached = resolveAttachedToolIds(rows);

  const mcpServers = q
    .getMcpServers(db, workspaceId)
    .filter((s) => s.enabled && attached.mcp.has(s.id));
  const customServices = q
    .getCustomServices(db, workspaceId)
    .filter((s) => s.enabled && attached.service.has(s.id));

  return { mcpServers, customServices };
}

/**
 * Build OpenAI tool defs for all external tools in scope for a project. MCP
 * servers are queried live (with the client's own error handling → []), so a
 * down server simply contributes no tools.
 */
export async function getExternalToolDefs(
  db: Database.Database,
  workspaceId: string,
  projectId: string
): Promise<OpenAIToolDef[]> {
  const { mcpServers, customServices } = loadScopedConfigs(db, workspaceId, projectId);

  const mcpDefs = (
    await Promise.all(
      mcpServers.map((s) => mcpClient.listTools(toRuntimeConfig(s)))
    )
  ).flat();

  const svcDefs = customServices.map((s) =>
    services.serviceToOpenAI({
      id: s.id,
      apiUrl: s.apiUrl,
      method: s.method,
      headers: s.headers,
      toolDefinition: s.toolDefinition,
      responseKeys: s.responseKeys,
    })
  );

  return [...mcpDefs, ...svcDefs];
}

// ── Routing ───────────────────────────────────────────────────────────────────

/** True if a tool name belongs to an external tool (MCP server or service). */
export function isExternalToolName(name: string): boolean {
  return mcpClient.isMcpToolName(name) || services.isServiceToolName(name);
}

/**
 * Execute an external tool by its namespaced name. Re-validates that the tool is
 * in the active scope (workspace-enabled AND attached to the project, globally or
 * directly) before running it — so a hallucinated or stale namespaced name can't
 * invoke a tool the loop wasn't actually offered. Returns a string result (or
 * error string) — never throws into the loop.
 */
export async function executeExternalTool(
  db: Database.Database,
  workspaceId: string,
  projectId: string,
  name: string,
  args: Record<string, unknown>
): Promise<string> {
  const { mcpServers, customServices } = loadScopedConfigs(db, workspaceId, projectId);

  const mcpParsed = mcpClient.parseToolName(name);
  if (mcpParsed) {
    const server = mcpServers.find((s) => s.id === mcpParsed.serverId);
    if (!server) {
      return `Error: MCP server ${mcpParsed.serverId} is not enabled/attached for this project`;
    }
    return mcpClient.callTool(
      toRuntimeConfig(server),
      name,
      args
    );
  }

  const svcParsed = services.parseServiceToolName(name);
  if (svcParsed) {
    const svc = customServices.find((s) => s.id === svcParsed.serviceId);
    if (!svc) {
      return `Error: service ${svcParsed.serviceId} is not enabled/attached for this project`;
    }
    return services.callService(
      {
        id: svc.id,
        apiUrl: svc.apiUrl,
        method: svc.method,
        headers: svc.headers,
        toolDefinition: svc.toolDefinition,
        responseKeys: svc.responseKeys,
      },
      name,
      args
    );
  }

  return `Error: "${name}" is not an external tool`;
}

// ── Display labels ──────────────────────────────────────────────────────────

/**
 * Turn a raw tool name into a friendly chip label. Snake_case / kebab-case /
 * dotted segments become spaced, capitalised words:
 *   "search-designs" → "Search designs", "create_issue" → "Create issue".
 */
export function prettifyToolName(toolName: string): string {
  const words = toolName.replace(/[_.\-]+/g, " ").replace(/\s+/g, " ").trim();
  if (!words) return toolName;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Human-readable label for an external (MCP / service) tool call, used for the
 * UI chip instead of the raw namespaced id (e.g. "mcp__BZfTDDlqAOoB__search-designs").
 *
 * Resolves the owning server/service display name from the DB when available so
 * the chip reads e.g. "Canva · Search designs"; falls back to just the
 * prettified tool name (or the raw name for anything non-external).
 */
export function externalToolLabel(name: string, db?: Database.Database): string {
  const mcpParsed = mcpClient.parseToolName(name);
  if (mcpParsed) {
    const pretty = prettifyToolName(mcpParsed.toolName);
    const server = db ? q.getMcpServerById(db, mcpParsed.serverId) : null;
    return server?.name ? `${server.name} · ${pretty}` : pretty;
  }
  const svcParsed = services.parseServiceToolName(name);
  if (svcParsed) {
    const pretty = prettifyToolName(svcParsed.toolName);
    const svc = db ? q.getCustomServiceById(db, svcParsed.serviceId) : null;
    return svc?.name ? `${svc.name} · ${pretty}` : pretty;
  }
  return name;
}

