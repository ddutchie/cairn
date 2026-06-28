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
import type { Database } from "better-sqlite3";
import * as q from "../db/queries";
import { newId } from "../db/utils";
import * as secrets from "../lib/secure-store";
import * as mcpClient from "../lib/mcp-client";
import * as services from "../lib/custom-services";

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

export function registerToolsHandlers(db: Database): void {
  // ── MCP servers ──────────────────────────────────────────────────────────
  registerIpcHandle("tools:listMcpServers", (_e, { workspaceId }: { workspaceId: string }) =>
    handle(() => q.getMcpServers(db, workspaceId))
  );

  registerIpcHandle("tools:saveMcpServer", (_e, server: SaveMcpArgs) =>
    handle(() => q.saveMcpServer(db, { ...server, id: server.id ?? newId(), headers: sanitizeHeaders(server.headers) }))
  );

  registerIpcHandle("tools:deleteMcpServer", (_e, { id }: { id: string }) =>
    handle(() => {
      q.deleteMcpServer(db, id);
      secrets.deleteToolSecrets("mcp", id); // purge any keychain credentials
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
      });
    })
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
      handle(() => secrets.setSecret(toolType, toolId, key, value))
  );

  registerIpcHandle(
    "secrets:has",
    (_e, { toolType, toolId, key }: { toolType: secrets.ToolKind; toolId: string; key: string }) =>
      handle(() => secrets.hasSecret(toolType, toolId, key))
  );

  registerIpcHandle(
    "secrets:delete",
    (_e, { toolType, toolId, key }: { toolType: secrets.ToolKind; toolId: string; key: string }) =>
      handle(() => secrets.deleteSecret(toolType, toolId, key))
  );
}
