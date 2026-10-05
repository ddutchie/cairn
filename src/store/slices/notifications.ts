/**
 * In-app notification center slice.
 *
 * Backs the sidebar bell + unread badge and the notification-center modal over
 * the persisted `mcp_notifications` table (automation completions, MCP writes,
 * approvals, etc.). Unread is DB-backed (read=0); the main-process poller pushes
 * live count changes over `mcp:unread-count` (subscribed here), and a fallback
 * 3s poll keeps the count fresh when the app is focused. Marking read updates
 * the DB and the local count.
 */

import type { StateCreator } from "zustand";
import type { CairnStore } from "../index";
import type { ID } from "@/types";
import type { McpNotification } from "../../../shared/types/notifications";
import { hasElectron, reportIpcError } from "@/lib/ipc/client";
import { notificationsClient } from "@/lib/ipc/tools";

export type { McpNotification };

// ── Slice interface ───────────────────────────────────────────────────────────

export interface NotificationsSlice {
  /** Recent notifications (read + unread), newest first. */
  notifications: McpNotification[];
  /** Live unread count for the bell badge. */
  notificationUnreadCount: number;

  fetchNotifications: (limit?: number) => Promise<void>;
  fetchNotificationUnread: () => Promise<void>;
  markNotificationRead: (id: ID) => Promise<void>;
  markAllNotificationsRead: () => Promise<void>;
  clearNotifications: () => Promise<void>;
  startNotificationPolling: () => void;
  stopNotificationPolling: () => void;
}

// ── Slice creator ─────────────────────────────────────────────────────────────

let unsubUnread: (() => void) | null = null;

export const createNotificationsSlice: StateCreator<CairnStore, [], [], NotificationsSlice> = (
  set,
  get
) => ({
  notifications: [],
  notificationUnreadCount: 0,

  async fetchNotifications(limit = 100) {
    if (!hasElectron("notification")) return;
    try {
      set({ notifications: await notificationsClient.list(limit) });
    } catch (err) {
      console.error("[notifications] fetchNotifications error", err);
    }
  },

  async fetchNotificationUnread() {
    if (!hasElectron("notification")) return;
    try {
      set({ notificationUnreadCount: await notificationsClient.unreadCount() });
    } catch (err) {
      console.error("[notifications] fetchNotificationUnread error", err);
    }
  },

  async markNotificationRead(id) {
    if (!hasElectron("notification")) return;
    try {
      await notificationsClient.markRead(id);
      set((s) => ({
        notifications: s.notifications.map((n) => (n.id === id ? { ...n, read: true } : n)),
        // Decrement only when this notification was previously unread.
        notificationUnreadCount: s.notifications.some((n) => n.id === id && !n.read)
          ? Math.max(0, s.notificationUnreadCount - 1)
          : s.notificationUnreadCount,
      }));
    } catch (err) {
      reportIpcError(err, "Couldn't mark the notification read");
    }
  },

  async markAllNotificationsRead() {
    if (!hasElectron("notification")) return;
    try {
      await notificationsClient.markAllRead();
      set((s) => ({
        notifications: s.notifications.map((n) => ({ ...n, read: true })),
        notificationUnreadCount: 0,
      }));
    } catch (err) {
      reportIpcError(err, "Couldn't mark notifications read");
    }
  },

  async clearNotifications() {
    if (!hasElectron("notification")) return;
    try {
      await notificationsClient.clear();
      set({ notifications: [], notificationUnreadCount: 0 });
    } catch (err) {
      reportIpcError(err, "Couldn't clear notifications");
    }
  },

  startNotificationPolling() {
    if (hasElectron("notification") && !unsubUnread) {
      unsubUnread = notificationsClient.onUnreadCount((count) => {
        set({ notificationUnreadCount: count });
      });
    }
    void get().fetchNotificationUnread();
  },

  stopNotificationPolling() {
    unsubUnread?.();
    unsubUnread = null;
  },
});
