"use client";

import { useEffect } from "react";
import { Bell, Check, CheckCheck, Zap } from "lucide-react";
import { ModalShell } from "@/components/ui/modal-shell";
import { Button } from "@/components/ui/button";
import { useCairnStore } from "@/store";
import { useShallow } from "zustand/react/shallow";
import { cn } from "@/lib/utils";

function formatWhen(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const diff = Date.now() - t;
  const mins = Math.round(diff / 60_000);
  const hrs = Math.round(diff / 3_600_000);
  const days = Math.round(diff / 86_400_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  if (hrs < 24) return `${hrs}h ago`;
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

/** Tool glyph for the notification row. */
function toolIcon(tool: string): React.ReactNode {
  if (tool === "automation_run" || tool === "automation_approval") return <Zap size={13} className="text-[var(--accent)]" />;
  return <Bell size={13} className="text-[var(--text-tertiary)]" />;
}

/**
 * In-app notification center — lists recent mcp_notifications (unread first)
 * with per-item dismiss and "Mark all read". Replaces the OS-toast-only surfacing
 * so automation completions and MCP activity are visible while focused.
 */
export function NotificationCenter({ onClose }: { onClose: () => void }) {
  const { notifications, notificationUnreadCount, fetchNotifications, markNotificationRead, markAllNotificationsRead } =
    useCairnStore(useShallow((s) => ({
      notifications: s.notifications,
      notificationUnreadCount: s.notificationUnreadCount,
      fetchNotifications: s.fetchNotifications,
      markNotificationRead: s.markNotificationRead,
      markAllNotificationsRead: s.markAllNotificationsRead,
    })));

  useEffect(() => {
    void fetchNotifications();
  }, [fetchNotifications]);

  const unread = notifications.filter((n) => !n.read);
  const sorted = [...unread, ...notifications.filter((n) => n.read)];

  return (
    <ModalShell
      onClose={onClose}
      size="lg"
      scrollable
      title={
        <span className="flex items-center gap-2">
          <Bell size={16} className="text-[var(--accent)]" /> Notifications
        </span>
      }
      description="Recent activity from automations and the app."
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>Close</Button>
          <Button
            variant="accent"
            size="sm"
            onClick={() => void markAllNotificationsRead()}
            disabled={notificationUnreadCount === 0}
          >
            <CheckCheck size={13} className="mr-1" /> Mark all read
          </Button>
        </>
      }
    >
      {notifications.length === 0 ? (
        <div className="py-10 text-center text-xs text-[var(--text-tertiary)] border border-dashed border-[var(--border)] rounded-lg">
          No notifications yet — automation completions and app activity will appear here.
        </div>
      ) : (
        <div className="flex flex-col gap-1.5 min-h-[8rem]">
          {sorted.map((n) => (
            <div
              key={n.id}
              className={cn(
                "flex items-start gap-3 rounded-lg border p-3",
                n.read ? "border-[var(--border)] bg-[var(--surface)] opacity-70" : "border-[var(--accent)]/30 bg-[var(--accent-dim)]/25"
              )}
            >
              <div className="mt-0.5 shrink-0">{toolIcon(n.tool)}</div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-[var(--text-primary)] truncate">{n.title}</span>
                  <span className="text-[0.65rem] text-[var(--text-tertiary)] ml-auto shrink-0">{formatWhen(n.createdAt)}</span>
                </div>
                <p className="text-xs text-[var(--text-secondary)] mt-0.5 break-words">{n.body}</p>
              </div>
              {!n.read && (
                <Button variant="ghost" size="icon" title="Dismiss" className="shrink-0" onClick={() => void markNotificationRead(n.id)}>
                  <Check size={13} />
                </Button>
              )}
            </div>
          ))}
        </div>
      )}
    </ModalShell>
  );
}
