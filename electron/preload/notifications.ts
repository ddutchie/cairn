/** MCP notification badge and in-app notification center. */

import { invokeContract, onIpcEvent } from "./ipc";

export const notificationsApi = {
  // ── MCP notification badge ─────────────────────
  onMcpUnreadCount: (cb: (count: number) => void) => onIpcEvent("mcp:unread-count", cb),
  markMcpNotificationsRead: () => invokeContract("mcp:markNotificationsRead"),

  // ── In-app notification center ─────────────────
  notification: {
    list: (limit?: number) => invokeContract("db:notification:list", { limit }),
    count: () => invokeContract("db:notification:count"),
    markRead: (id: string) => invokeContract("db:notification:markRead", { id }),
    markAllRead: () => invokeContract("mcp:markNotificationsRead"),
    clear: () => invokeContract("db:notification:clear"),
  },
} as const;
