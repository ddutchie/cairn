/**
 * Cairn — coding-agent registry + external tools (MCP servers, custom HTTP
 * services, per-project attachments) queries.
 *
 * Part of the `electron/db/queries.ts` per-domain split (cleanup Phase 4).
 * Re-exported from `./queries` so existing importers keep working unchanged.
 *
 * Governance: NEVER construct a Database here — these run on the
 * already-constructed handle passed in by the caller. See `./queries.ts`
 * header for the three ABI bootstrap sites.
 */

import type Database from "better-sqlite3";
import { ts } from "./utils";
import { toCodingAgent, toMcpServer, toCustomService, toToolAttachment, j, type DbRow } from "../host-shared/db-mappers";

// ── Coding Agents ─────────────────────────────────────────────────────────────

export function getCodingAgents(db: Database.Database) {
  return (db.prepare("SELECT * FROM coding_agents ORDER BY created_at").all() as unknown[])
    .map((row) => toCodingAgent(row as DbRow));
}

export function getCodingAgentById(db: Database.Database, id: string) {
  const row = db.prepare("SELECT * FROM coding_agents WHERE id = ?").get(id);
  return row ? toCodingAgent(row as DbRow) : null;
}

export function saveCodingAgent(
  db: Database.Database,
  agent: { id: string; name: string; binaryPath: string; args: string; isDefault: boolean },
) {
  const now = ts();
  db.prepare(`
    INSERT INTO coding_agents (id, name, binary_path, args, is_default, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name        = excluded.name,
      binary_path = excluded.binary_path,
      args        = excluded.args,
      is_default  = excluded.is_default,
      updated_at  = excluded.updated_at
  `).run(agent.id, agent.name, agent.binaryPath, agent.args, agent.isDefault ? 1 : 0, now, now);
  return getCodingAgentById(db, agent.id)!;
}

export function setDefaultCodingAgent(db: Database.Database, id: string) {
  const setDefault = db.transaction(() => {
    db.prepare("UPDATE coding_agents SET is_default = 0, updated_at = ?").run(ts());
    db.prepare("UPDATE coding_agents SET is_default = 1, updated_at = ? WHERE id = ?").run(ts(), id);
  });
  setDefault();
}

export function deleteCodingAgent(db: Database.Database, id: string) {
  db.prepare("DELETE FROM coding_agents WHERE id = ?").run(id);
}

export function setProjectCodeDirectory(db: Database.Database, projectId: string, path: string | null) {
  db.prepare("UPDATE projects SET code_directory = ?, updated_at = ? WHERE id = ?")
    .run(path ?? null, ts(), projectId);
}

// ── External Tools: MCP servers ───────────────────────────────────────────────

interface McpServerInput {
  id: string; workspaceId: string; name: string; description?: string;
  transport: "sse" | "http"; baseUrl: string; headers?: Record<string, string>;
  authMode?: "none" | "oauth"; oauthScope?: string;
  oauthClientId?: string; oauthRedirectUri?: string; oauthClientIdRequired?: boolean;
  enabled: boolean; source: string; communityId?: string; version?: string;
  /** Raw (un-namespaced) tool names disabled for this server, workspace-wide. */
  disabledTools?: string[];
  /** Dev-only: route this server through dsh-mcp-client (parity spike). */
  dshPath?: boolean;
}

export function getMcpServers(db: Database.Database, workspaceId: string) {
  return (db.prepare("SELECT * FROM mcp_servers WHERE workspace_id = ? ORDER BY created_at").all(workspaceId) as unknown[])
    .map((row) => toMcpServer(row as DbRow));
}

export function getMcpServerById(db: Database.Database, id: string) {
  const row = db.prepare("SELECT * FROM mcp_servers WHERE id = ?").get(id);
  return row ? toMcpServer(row as DbRow) : null;
}

export function saveMcpServer(db: Database.Database, s: McpServerInput) {
  const now = ts();
  db.prepare(`
    INSERT INTO mcp_servers (id, workspace_id, name, description, transport, base_url, headers, auth_mode, oauth_scope, oauth_client_id, oauth_redirect_uri, oauth_client_id_required, enabled, source, community_id, version, disabled_tools, dsh_path, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name        = excluded.name,
      description = excluded.description,
      transport   = excluded.transport,
      base_url    = excluded.base_url,
      headers     = excluded.headers,
      auth_mode   = excluded.auth_mode,
      oauth_scope = excluded.oauth_scope,
      oauth_client_id        = excluded.oauth_client_id,
      oauth_redirect_uri     = excluded.oauth_redirect_uri,
      oauth_client_id_required = excluded.oauth_client_id_required,
      enabled     = excluded.enabled,
      source      = excluded.source,
      community_id= excluded.community_id,
      version     = excluded.version,
      disabled_tools = excluded.disabled_tools,
      dsh_path    = excluded.dsh_path,
      updated_at  = excluded.updated_at
  `).run(
    s.id, s.workspaceId, s.name, s.description ?? null, s.transport, s.baseUrl,
    j(s.headers ?? {}), s.authMode ?? "none", s.oauthScope ?? null,
    s.oauthClientId ?? null, s.oauthRedirectUri ?? null, s.oauthClientIdRequired ? 1 : 0,
    s.enabled ? 1 : 0, s.source, s.communityId ?? null, s.version ?? null,
    j(s.disabledTools ?? []), s.dshPath ? 1 : 0, now, now,
  );
  return getMcpServerById(db, s.id)!;
}

export function deleteMcpServer(db: Database.Database, id: string) {
  db.prepare("DELETE FROM mcp_servers WHERE id = ?").run(id);
  db.prepare("DELETE FROM tool_attachments WHERE tool_type = 'mcp' AND tool_id = ?").run(id);
}

// ── External Tools: custom HTTP services ──────────────────────────────────────

interface CustomServiceInput {
  id: string; workspaceId: string; name: string; description?: string;
  apiUrl?: string; method?: "GET" | "POST" | "PUT" | "DELETE"; headers?: Record<string, string>;
  toolDefinition?: string; responseKeys?: string[]; apiKeyUrl?: string;
  baseUrl?: string; operations?: unknown[];
  authMode?: "none" | "oauth";
  oauth?: { serverUrl?: string; scope?: string; clientId?: string; redirectUri?: string; authorizationUrl?: string; tokenUrl?: string };
  enabled: boolean; source: string; communityId?: string; version?: string;
}

export function getCustomServices(db: Database.Database, workspaceId: string) {
  return (db.prepare("SELECT * FROM custom_services WHERE workspace_id = ? ORDER BY created_at").all(workspaceId) as unknown[])
    .map((row) => toCustomService(row as DbRow));
}

export function getCustomServiceById(db: Database.Database, id: string) {
  const row = db.prepare("SELECT * FROM custom_services WHERE id = ?").get(id);
  return row ? toCustomService(row as DbRow) : null;
}

export function saveCustomService(db: Database.Database, s: CustomServiceInput) {
  const now = ts();
  db.prepare(`
    INSERT INTO custom_services (id, workspace_id, name, description, api_url, method, headers, tool_definition, base_url, operations, response_keys, api_key_url, enabled, source, community_id, version, auth_mode, oauth_config, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name            = excluded.name,
      description     = excluded.description,
      api_url         = excluded.api_url,
      method          = excluded.method,
      headers         = excluded.headers,
      tool_definition = excluded.tool_definition,
      base_url        = excluded.base_url,
      operations      = excluded.operations,
      response_keys   = excluded.response_keys,
      api_key_url     = excluded.api_key_url,
      enabled         = excluded.enabled,
      source          = excluded.source,
      community_id    = excluded.community_id,
      version         = excluded.version,
      auth_mode       = excluded.auth_mode,
      oauth_config    = excluded.oauth_config,
      updated_at      = excluded.updated_at
  `).run(
    s.id, s.workspaceId, s.name, s.description ?? null, s.apiUrl ?? "", s.method ?? "GET",
    j(s.headers ?? {}), s.toolDefinition ?? "", s.baseUrl ?? null,
    s.operations ? JSON.stringify(s.operations) : null,
    j(s.responseKeys ?? []), s.apiKeyUrl ?? null,
    s.enabled ? 1 : 0, s.source, s.communityId ?? null, s.version ?? null,
    s.authMode ?? "none", s.oauth ? JSON.stringify(s.oauth) : null, now, now,
  );
  return getCustomServiceById(db, s.id)!;
}

export function deleteCustomService(db: Database.Database, id: string) {
  db.prepare("DELETE FROM custom_services WHERE id = ?").run(id);
  db.prepare("DELETE FROM tool_attachments WHERE tool_type = 'service' AND tool_id = ?").run(id);
}

// ── External Tools: per-project attachments ───────────────────────────────────

export function getToolAttachments(db: Database.Database, projectId: string) {
  return (db.prepare("SELECT * FROM tool_attachments WHERE project_id = ?").all(projectId) as unknown[])
    .map((row) => toToolAttachment(row as DbRow));
}

export function setToolAttachment(
  db: Database.Database,
  a: { projectId: string; toolType: "mcp" | "service"; toolId: string; enabled: boolean },
) {
  db.prepare(`
    INSERT INTO tool_attachments (project_id, tool_type, tool_id, enabled)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(project_id, tool_type, tool_id) DO UPDATE SET enabled = excluded.enabled
  `).run(a.projectId, a.toolType, a.toolId, a.enabled ? 1 : 0);
  return a;
}

export function clearToolAttachment(
  db: Database.Database,
  a: { projectId: string; toolType: "mcp" | "service"; toolId: string },
) {
  db.prepare("DELETE FROM tool_attachments WHERE project_id = ? AND tool_type = ? AND tool_id = ?")
    .run(a.projectId, a.toolType, a.toolId);
}
