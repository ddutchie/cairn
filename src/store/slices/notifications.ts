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

export interface McpNotification {
  id: ID;
  tool: string;
  title: string;
  body: string;
  read: boolean;
  createdAt: string;
}

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
  startNotificationPolling: () => void;
  stopNotificationPolling: () => void;
}

// ── Slice creator ─────────────────────────────────────────────────────────────

let notificationPollTimer: ReturnType<typeof setInterval> | null = null;
let unsubUnread: (() => void) | null = null;
const NOTIFICATION_POLL_MS = 3_000;

export const createNotificationsSlice: StateCreator<CairnStore, [], [], NotificationsSlice> = (
  set,
  get
) => ({
  notifications: [],
  notificationUnreadCount: 0,

  async fetchNotifications(limit = 100) {
    if (typeof window === "undefined" || !window.electron?.notification) return;
    try {
      const rows = (await window.electron.notification.list(limit)) as McpNotification[];
      set({ notifications: rows });
    } catch (err) {
      console.error("[notifications] fetchNotifications error", err);
    }
  },

  async fetchNotificationUnread() {
    if (typeof window === "undefined" || !window.electron?.notification) return;
    try {
      const n = (await window.electron.notification.count()) as number;
      set({ notificationUnreadCount: n });
    } catch (err) {
      console.error("[notifications] fetchNotificationUnread error", err);
    }
  },

  async markNotificationRead(id) {
    if (typeof window === "undefined" || !window.electron?.notification) return;
    try {
      await window.electron.notification.markRead(id);
      set((s) => ({
        notifications: s.notifications.map((n) => (n.id === id ? { ...n, read: true } : n)),
        notificationUnreadCount: Math.max(0, s.notificationUnreadCount - 1),
      }));
    } catch (err) {
      console.error("[notifications] markNotificationRead error", err);
    }
  },

  async markAllNotificationsRead() {
    if (typeof window === "undefined" || !window.electron?.notification) return;
    try {
      await window.electron.notification.markAllRead();
      set((s) => ({
        notifications: s.notifications.map((n) => ({ ...n, read: true })),
        notificationUnreadCount: 0,
      }));
    } catch (err) {
      console.error("[notifications] markAllNotificationsRead error", err);
    }
  },

  startNotificationPolling() {
    if (notificationPollTimer) return;
    const electron = typeof window !== "undefined" ? window.electron : undefined;
    if (electron?.notification && electron.onMcpUnreadCount && !unsubUnread) {
      unsubUnread = electron.onMcpUnreadCount((count) => {
        set({ notificationUnreadCount: count });
      });
    }
    void get().fetchNotificationUnread();
    notificationPollTimer = setInterval(() => {
      void get().fetchNotificationUnread();
    }, NOTIFICATION_POLL_MS);
  },

  stopNotificationPolling() {
    if (notificationPollTimer) {
      clearInterval(notificationPollTimer);
      notificationPollTimer = null;
    }
    unsubUnread?.();
    unsubUnread = null;
  },
});
