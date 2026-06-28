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

type SaveMcpArgs = Omit<Parameters<typeof q.saveMcpServer>[1], "id"> & { id?: string };
type SaveServiceArgs = Omit<Parameters<typeof q.saveCustomService>[1], "id"> & { id?: string };

export function registerToolsHandlers(db: Database): void {
  // ── MCP servers ──────────────────────────────────────────────────────────
  registerIpcHandle("tools:listMcpServers", (_e, { workspaceId }: { workspaceId: string }) =>
    handle(() => q.getMcpServers(db, workspaceId))
  );

  registerIpcHandle("tools:saveMcpServer", (_e, server: SaveMcpArgs) =>
    handle(() => q.saveMcpServer(db, { ...server, id: server.id ?? newId() }))
  );

  registerIpcHandle("tools:deleteMcpServer", (_e, { id }: { id: string }) =>
    handle(() => {
      q.deleteMcpServer(db, id);
      secrets.deleteToolSecrets(id); // purge any keychain credentials
    })
  );

  // ── Custom HTTP services ─────────────────────────────────────────────────
  registerIpcHandle("tools:listServices", (_e, { workspaceId }: { workspaceId: string }) =>
    handle(() => q.getCustomServices(db, workspaceId))
  );

  registerIpcHandle("tools:saveService", (_e, service: SaveServiceArgs) =>
    handle(() => q.saveCustomService(db, { ...service, id: service.id ?? newId() }))
  );

  registerIpcHandle("tools:deleteService", (_e, { id }: { id: string }) =>
    handle(() => {
      q.deleteCustomService(db, id);
      secrets.deleteToolSecrets(id); // purge any keychain credentials
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
    (_e, { toolId, key, value }: { toolId: string; key: string; value: string }) =>
      handle(() => secrets.setSecret(toolId, key, value))
  );

  registerIpcHandle(
    "secrets:has",
    (_e, { toolId, key }: { toolId: string; key: string }) =>
      handle(() => secrets.hasSecret(toolId, key))
  );

  registerIpcHandle(
    "secrets:delete",
    (_e, { toolId, key }: { toolId: string; key: string }) =>
      handle(() => secrets.deleteSecret(toolId, key))
  );
}
