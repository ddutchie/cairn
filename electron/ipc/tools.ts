/**
 * External Tools IPC — workspace-scoped MCP servers + custom HTTP services,
 * and per-project attachment flags.
 *
 * CRUD only (storage + plumbing). Tool execution (MCP client, service
 * executor) and the AI builder land in later cards. Header secret values are
 * stored as "secret://<toolId>/<header>" refs here; the real values live in
 * the OS keychain via the secure store (separate card).
 *
 * All handlers use the handle() wrapper for { data } | { error } responses.
 */

import { registerIpcHandle } from "./registry";
import { handle } from "./result-helpers";
import { broadcastEvent } from "./registry";
import type { Database } from "better-sqlite3";
import * as q from "../db/queries";
import { newId } from "../db/utils";
import * as secrets from "../lib/secure-store";
import * as mcpClient from "../lib/mcp-client";
import * as services from "../lib/custom-services";
import * as mcpOauth from "../lib/mcp-oauth";

type SaveMcpArgs = Omit<Parameters<typeof q.saveMcpServer>[1], "id"> & { id?: string };
type SaveServiceArgs = Omit<Parameters<typeof q.saveCustomService>[1], "id"> & { id?: string };

/**
 * Reject plain-secret header values before they hit SQLite. Only literal
 * non-secret values or `secret://` refs may be persisted; an unfilled
 * placeholder is dropped (the UI prompts for the real value, which is stored in
 * the keychain). This is a defense-in-depth backstop even if a renderer forgets
 * to route a credential through the secure store.
 */
function sanitizeHeaders(headers?: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (secrets.isSecretRef(value)) {
      out[name] = value; // already a ref — safe to store
    } else if (secrets.isPlaceholder(value) || secrets.containsPlaceholder(value)) {
      // Unfilled placeholder — drop it; the real value belongs in the keychain.
    } else if (looksLikeBareCredential(name, value)) {
      throw new Error(
        `Refusing to store a plaintext credential in header "${name}". Store it via the secure store and pass a secret:// ref instead.`
      );
    } else {
      out[name] = value;
    }
  }
  return out;
}

/**
 * Heuristic: an Authorization/api-key header whose value is a non-empty literal
 * (not a ref, not a placeholder) is almost certainly a real credential.
 */
function looksLikeBareCredential(name: string, value: string): boolean {
  if (!value.trim()) return false;
  const n = name.toLowerCase();
  if (n === "authorization" || /api[_-]?key|token|secret|access[_-]?key/.test(n)) return true;
  if (/^bearer\s+\S/i.test(value)) return true;
  return false;
}

/**
 * True if a save changes a field that invalidates previously-issued OAuth state
 * (tokens / dynamic client registration) for the same server id — the endpoint
 * or auth configuration it points at.
 */
function oauthConfigChanged(
  prev: { baseUrl: string; transport: string; authMode?: string; oauthScope?: string },
  next: { baseUrl?: string; transport?: string; authMode?: string; oauthScope?: string },
): boolean {
  return (
    (next.baseUrl !== undefined && next.baseUrl !== prev.baseUrl) ||
    (next.transport !== undefined && next.transport !== prev.transport) ||
    (next.authMode !== undefined && (next.authMode ?? "none") !== (prev.authMode ?? "none")) ||
    (next.oauthScope !== undefined && (next.oauthScope ?? "") !== (prev.oauthScope ?? ""))
  );
}

export function registerToolsHandlers(db: Database): void {
  // ── MCP servers ──────────────────────────────────────────────────────────
  registerIpcHandle("tools:listMcpServers", (_e, { workspaceId }: { workspaceId: string }) =>
    handle(() => q.getMcpServers(db, workspaceId))
  );

  registerIpcHandle("tools:saveMcpServer", (_e, server: SaveMcpArgs) =>
    handle(() => {
      const id = server.id ?? newId();
      // On edit, if any connection/auth-relevant field changed, the stored OAuth
      // artefacts (tokens + client registration) no longer apply — they were
      // issued for the old authorization server / config. Clear them so the id
      // only preserves OAuth state when the auth config is unchanged.
      if (server.id) {
        const prev = q.getMcpServerById(db, server.id);
        if (prev && oauthConfigChanged(prev, server)) {
          mcpOauth.signOut(id);
          mcpOauth.cancelServerAuth(id); // tear down loopback listener + deep-link attempt
          void mcpClient.dispose(id);
        }
      }
      return q.saveMcpServer(db, { ...server, id, headers: sanitizeHeaders(server.headers) });
    })
  );

  registerIpcHandle("tools:deleteMcpServer", (_e, { id }: { id: string }) =>
    handle(() => {
      q.deleteMcpServer(db, id);
      mcpOauth.cancelServerAuth(id); // drop any in-flight OAuth attempt (loopback + deep-link)
      secrets.deleteToolSecrets("mcp", id); // purge keychain credentials + OAuth tokens
      void mcpClient.dispose(id); // drop any live connection
    })
  );

  // Settings "test connection": connect + listTools, then disconnect.
  registerIpcHandle("tools:testMcp", (_e, { id }: { id: string }) =>
    handle(() => {
      const server = q.getMcpServerById(db, id);
      if (!server) throw new Error("MCP server not found");
      return mcpClient.testConnection({
        id: server.id,
        baseUrl: server.baseUrl,
        transport: server.transport,
        headers: server.headers,
        authMode: server.authMode,
        oauthScope: server.oauthScope,
        name: server.name,
      });
    })
  );

  // List a server's individual tools (raw name + description) for the per-tool
  // enable/disable checklist in Settings. Keeps the cached connection alive.
  registerIpcHandle("tools:listMcpTools", (_e, { id }: { id: string }) =>
    handle(() => {
      const server = q.getMcpServerById(db, id);
      if (!server) throw new Error("MCP server not found");
      return mcpClient.listToolsDetailed({
        id: server.id,
        baseUrl: server.baseUrl,
        transport: server.transport,
        headers: server.headers,
        authMode: server.authMode,
        oauthScope: server.oauthScope,
        name: server.name,
      });
    })
  );

  // ── MCP OAuth ──────────────────────────────────────────────────────────────
  // Begin sign-in: opens the system browser; resolves once the redirect has been
  // triggered. Completion arrives via either the loopback listener (default) or
  // the cairn://oauth/callback deep link; both forward a tools:oauthCallback
  // event to the renderer so Settings can refresh the connection state.
  registerIpcHandle("tools:startMcpAuth", (_e, { id }: { id: string }) =>
    handle(() => {
      const server = q.getMcpServerById(db, id);
      if (!server) throw new Error("MCP server not found");
      if (server.authMode !== "oauth") throw new Error("Server is not configured for OAuth");
      return mcpOauth.startServerAuth(
        { id: server.id, baseUrl: server.baseUrl, transport: server.transport, scope: server.oauthScope },
        server.name,
        (result) => broadcastEvent("tools:oauthCallback", result),
      );
    })
  );

  // Whether the server currently holds OAuth tokens (i.e. is "connected").
  registerIpcHandle("tools:mcpAuthStatus", (_e, { id }: { id: string }) =>
    handle(() => ({ connected: mcpOauth.hasTokens(id) }))
  );

  // Sign out: forget tokens/registration and drop any live connection.
  registerIpcHandle("tools:signOutMcp", (_e, { id }: { id: string }) =>
    handle(() => {
      mcpOauth.signOut(id);
      mcpOauth.cancelServerAuth(id); // tear down loopback listener + deep-link attempt
      void mcpClient.dispose(id);
    })
  );

  // Cancel an in-flight sign-in (user abandoned the browser step). Tears down
  // the waiting loopback listener → the flow reports a cancelled completion.
  registerIpcHandle("tools:cancelMcpAuth", (_e, { id }: { id: string }) =>
    handle(() => ({ cancelled: mcpOauth.cancelServerAuth(id) }))
  );

  // ── Custom HTTP services ─────────────────────────────────────────────────
  registerIpcHandle("tools:listServices", (_e, { workspaceId }: { workspaceId: string }) =>
    handle(() => q.getCustomServices(db, workspaceId))
  );

  registerIpcHandle("tools:saveService", (_e, service: SaveServiceArgs) =>
    handle(() => q.saveCustomService(db, { ...service, id: service.id ?? newId(), headers: sanitizeHeaders(service.headers) }))
  );

  registerIpcHandle("tools:deleteService", (_e, { id }: { id: string }) =>
    handle(() => {
      q.deleteCustomService(db, id);
      secrets.deleteToolSecrets("service", id); // purge any keychain credentials
    })
  );

  // Settings dry-run for a service.
  registerIpcHandle(
    "tools:testService",
    (_e, { id, sampleArgs }: { id: string; sampleArgs?: Record<string, unknown> }) =>
      handle(() => {
        const svc = q.getCustomServiceById(db, id);
        if (!svc) throw new Error("Service not found");
        return services.testService(
          {
            id: svc.id,
            apiUrl: svc.apiUrl,
            method: svc.method,
            headers: svc.headers,
            toolDefinition: svc.toolDefinition,
            responseKeys: svc.responseKeys,
          },
          sampleArgs ?? {}
        );
      })
  );

  // ── Per-project attachments ──────────────────────────────────────────────
  registerIpcHandle("tools:listAttachments", (_e, { projectId }: { projectId: string }) =>
    handle(() => q.getToolAttachments(db, projectId))
  );

  registerIpcHandle("tools:setAttachment", (_e, a: Parameters<typeof q.setToolAttachment>[1]) =>
    handle(() => q.setToolAttachment(db, a))
  );

  registerIpcHandle("tools:clearAttachment", (_e, a: Parameters<typeof q.clearToolAttachment>[1]) =>
    handle(() => q.clearToolAttachment(db, a))
  );

  // ── Secrets (OS keychain) ────────────────────────────────────────────────
  // NOTE: there is intentionally NO "secrets:get" — the renderer can only learn
  // whether a secret is set, set a new value, or delete one. Decryption happens
  // only in the main process at tool-execution time (resolveSecrets).
  registerIpcHandle("secrets:available", () => handle(() => secrets.isAvailable()));

  registerIpcHandle(
    "secrets:set",
    (_e, { toolType, toolId, key, value }: { toolType: secrets.ToolKind; toolId: string; key: string; value: string }) =>
      handle(() => {
        assertSecretIdentity(toolType, toolId, key);
        return secrets.setSecret(toolType, toolId, key, value);
      })
  );

  registerIpcHandle(
    "secrets:has",
    (_e, { toolType, toolId, key }: { toolType: secrets.ToolKind; toolId: string; key: string }) =>
      handle(() => {
        assertSecretIdentity(toolType, toolId, key);
        return secrets.hasSecret(toolType, toolId, key);
      })
  );

  registerIpcHandle(
    "secrets:delete",
    (_e, { toolType, toolId, key }: { toolType: secrets.ToolKind; toolId: string; key: string }) =>
      handle(() => {
        assertSecretIdentity(toolType, toolId, key);
        return secrets.deleteSecret(toolType, toolId, key);
      })
  );
}

/**
 * Validate the tool identity supplied by the renderer before any keychain
 * mutation. This is a desktop app with a single trusted renderer, so there is
 * no per-renderer ownership boundary to enforce — but a malformed payload must
 * never create a junk ref or address the wrong tool kind's namespace.
 */
function assertSecretIdentity(toolType: string, toolId: string, key: string): void {
  if (toolType !== "mcp" && toolType !== "service") {
    throw new Error(`Invalid secret toolType: ${String(toolType)}`);
  }
  if (typeof toolId !== "string" || !toolId.trim()) {
    throw new Error("Invalid secret toolId");
  }
  if (typeof key !== "string" || !key.trim()) {
    throw new Error("Invalid secret key");
  }
}
