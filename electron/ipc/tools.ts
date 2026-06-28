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
    handle(() => q.deleteMcpServer(db, id))
  );

  // ── Custom HTTP services ─────────────────────────────────────────────────
  registerIpcHandle("tools:listServices", (_e, { workspaceId }: { workspaceId: string }) =>
    handle(() => q.getCustomServices(db, workspaceId))
  );

  registerIpcHandle("tools:saveService", (_e, service: SaveServiceArgs) =>
    handle(() => q.saveCustomService(db, { ...service, id: service.id ?? newId() }))
  );

  registerIpcHandle("tools:deleteService", (_e, { id }: { id: string }) =>
    handle(() => q.deleteCustomService(db, id))
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
}
