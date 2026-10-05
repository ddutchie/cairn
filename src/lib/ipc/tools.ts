/**
 * Typed clients for the external-tools IPC channels (`tools:*`), the OS
 * keychain (`secrets:*`) and the in-app notification center
 * (`db:notification:*`, `mcp:markNotificationsRead`). Every failure rejects
 * with the main-process message; off-Electron calls reject with
 * `IpcUnavailableError`.
 */

import type { McpNotification } from "../../../shared/types/notifications";
import type {
  AuthCompleteResult, CustomServiceConfig, McpServerConfig, SecretToolType, ToolAttachment, ToolType,
} from "../../../shared/types/tools";
import { domainCall, type ElectronApi } from "./client";

const tools = <T>(fn: (api: ElectronApi["tools"]) => Promise<T>) => domainCall("tools", fn);
const secrets = <T>(fn: (api: ElectronApi["secrets"]) => Promise<T>) => domainCall("secrets", fn);
const notification = <T>(fn: (api: ElectronApi["notification"]) => Promise<T>) => domainCall("notification", fn);

export const toolsClient = {
  listMcpServers: (workspaceId: string): Promise<McpServerConfig[]> => tools((t) => t.listMcpServers(workspaceId)),
  /** Upsert; a missing `id` creates. */
  saveMcpServer: (server: Partial<McpServerConfig>): Promise<McpServerConfig> => tools((t) => t.saveMcpServer(server)),
  deleteMcpServer: (id: string) => tools((t) => t.deleteMcpServer(id)),
  /** Connection failures resolve as `{ ok: false, error }`, not a rejection. */
  testMcp: (id: string) => tools((t) => t.testMcp(id)),
  /** Connection failures resolve as `{ ok: false, error }`, not a rejection. */
  listMcpTools: (id: string) => tools((t) => t.listMcpTools(id)),

  listServices: (workspaceId: string): Promise<CustomServiceConfig[]> => tools((t) => t.listServices(workspaceId)),
  saveService: (service: Partial<CustomServiceConfig>): Promise<CustomServiceConfig> =>
    tools((t) => t.saveService(service)),
  deleteService: (id: string) => tools((t) => t.deleteService(id)),
  testService: (id: string, sampleArgs?: Record<string, unknown>) => tools((t) => t.testService(id, sampleArgs)),

  listAttachments: (projectId: string): Promise<ToolAttachment[]> => tools((t) => t.listAttachments(projectId)),
  setAttachment: (a: ToolAttachment) => tools((t) => t.setAttachment(a)),
  clearAttachment: (a: Omit<ToolAttachment, "enabled">) => tools((t) => t.clearAttachment(a)),

  /** OAuth for either tool kind; completion arrives via {@link toolsClient.onOauthCallback}. */
  startAuth: (toolType: ToolType, id: string) =>
    tools((t) => (toolType === "mcp" ? t.startMcpAuth(id) : t.startServiceAuth(id))),
  authStatus: (toolType: ToolType, id: string) =>
    tools((t) => (toolType === "mcp" ? t.mcpAuthStatus(id) : t.serviceAuthStatus(id))),
  signOut: (toolType: ToolType, id: string) =>
    tools((t) => (toolType === "mcp" ? t.signOutMcp(id) : t.signOutService(id))),
  cancelAuth: (toolType: ToolType, id: string) =>
    tools((t) => (toolType === "mcp" ? t.cancelMcpAuth(id) : t.cancelServiceAuth(id))),
  /** Subscribe to sign-in completions; returns the unsubscribe function (a no-op off-Electron). */
  onOauthCallback: (cb: (e: AuthCompleteResult) => void): (() => void) =>
    window.electron?.tools?.onOauthCallback(cb) ?? (() => {}),
};

/** OS keychain. There is deliberately no `get`: the renderer only learns whether a secret is set. */
export const secretsClient = {
  available: (): Promise<boolean> => secrets((s) => s.available()),
  /** Stores the value and returns the `secret://` ref to persist in its place. */
  set: (toolType: SecretToolType, toolId: string, key: string, value: string): Promise<string> =>
    secrets((s) => s.set(toolType, toolId, key, value)),
  has: (toolType: SecretToolType, toolId: string, key: string): Promise<boolean> =>
    secrets((s) => s.has(toolType, toolId, key)),
  delete: (toolType: SecretToolType, toolId: string, key: string) => secrets((s) => s.delete(toolType, toolId, key)),
};

export const notificationsClient = {
  list: (limit?: number): Promise<McpNotification[]> => notification((n) => n.list(limit)),
  unreadCount: (): Promise<number> => notification((n) => n.count()),
  markRead: (id: string) => notification((n) => n.markRead(id)),
  /** Marks everything read and clears the dock/tray badge. */
  markAllRead: () => notification((n) => n.markAllRead()),
  /** Deletes every notification; resolves to the number removed. */
  clear: (): Promise<number> => notification((n) => n.clear()),
  /** Subscribe to unread-count pushes; returns the unsubscribe function (a no-op off-Electron). */
  onUnreadCount: (cb: (count: number) => void): (() => void) =>
    window.electron?.onMcpUnreadCount?.(cb) ?? (() => {}),
};
