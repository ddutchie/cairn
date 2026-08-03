"use client";

import { useEffect, useRef } from "react";
import { Bell, Check, CheckCheck, Zap, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useCairnStore } from "@/store";
import { useShallow } from "zustand/react/shallow";
import { cn } from "@/lib/utils";
import { revealNote, revealCard } from "@/lib/events";

function formatWhen(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const mins = Math.round((Date.now() - t) / 60_000);
  const hrs = Math.round(mins / 60);
  const days = Math.round(hrs / 24);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m`;
  if (hrs < 24) return `${hrs}h`;
  if (days < 30) return `${days}d`;
  return new Date(iso).toLocaleDateString();
}

function toolIcon(tool: string): React.ReactNode {
  if (tool === "automation_run" || tool === "automation_approval") return <Zap size={13} className="text-[var(--accent)]" />;
  return <Bell size={13} className="text-[var(--text-tertiary)]" />;
}

/**
 * In-app notification center — a thin popover (like the sync indicator) shown
 * top-right over whatever is open. Rows that reference a note/task navigate to
 * it in place (the popup stays open) so you can jump to the result without
 * dismissing. Closes on outside click / Escape.
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

  const { setView } = useCairnStore(useShallow((s) => ({ setView: s.setView })));

  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void fetchNotifications();
  }, [fetchNotifications]);

  // Close on outside click / Escape (the popover only exists while open).
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const unread = notifications.filter((n) => !n.read);
  const sorted = [...unread, ...notifications.filter((n) => n.read)];

  return (
    <div ref={wrapRef} className="fixed top-[calc(40px+8px)] right-3 z-50 w-80 rounded-xl border border-[var(--border)] bg-[var(--surface)] shadow-2xl animate-fade-in flex flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-[var(--border-subtle)] bg-[var(--surface-2)]">
        <Bell size={13} className="text-[var(--accent)]" />
        <span className="text-xs font-semibold text-[var(--text-primary)]">Notifications</span>
        {notificationUnreadCount > 0 && (
          <span className="text-[0.65rem] px-1.5 py-0.5 rounded-full bg-[var(--accent)] text-[var(--accent-fg,#fff)] font-semibold">
            {notificationUnreadCount}
          </span>
        )}
        <Button variant="ghost" size="xs" className="ml-auto" onClick={() => void markAllNotificationsRead()} disabled={notificationUnreadCount === 0}>
          <CheckCheck size={12} className="mr-1" /> Mark all read
        </Button>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto max-h-80 py-1">
        {notifications.length === 0 ? (
          <p className="px-3 py-8 text-center text-[0.714rem] text-[var(--text-tertiary)]">
            No notifications yet — automation completions and app activity will appear here.
          </p>
        ) : (
          sorted.map((n) => {
            const targetable = n.targetType === "note" || n.targetType === "task" || n.targetType === "automation";
            const onClick = targetable
              ? () => {
                  if (n.targetType === "note") revealNote(setView, n.targetId!);
                  else if (n.targetType === "task") revealCard(setView, n.targetId!);
                  else if (n.targetType === "automation") setView("automations");
                }
              : undefined;
            return (
              <div
                key={n.id}
                onClick={onClick}
                role={targetable ? "button" : undefined}
                tabIndex={targetable ? 0 : undefined}
                onKeyDown={targetable ? (e) => { if (e.key === "Enter") onClick?.(); } : undefined}
                className={cn(
                  "flex items-start gap-2.5 px-3 py-2 text-left",
                  targetable ? "cursor-pointer hover:bg-[var(--surface-2)]" : "",
                  n.read ? "opacity-60" : "bg-[color-mix(in_srgb,var(--accent)_6%,transparent)]"
                )}
              >
                <div className="mt-0.5 shrink-0">{toolIcon(n.tool)}</div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-medium text-[var(--text-primary)] truncate">{n.title}</span>
                {targetable && <ExternalLink size={10} className="shrink-0 text-[var(--text-tertiary)]" />}
                    <span className="text-[0.625rem] text-[var(--text-tertiary)] ml-auto shrink-0">{formatWhen(n.createdAt)}</span>
                  </div>
                  <p className="text-[0.714rem] text-[var(--text-secondary)] mt-0.5 break-words line-clamp-2">{n.body}</p>
                </div>
                {!n.read && (
                  <Button variant="ghost" size="icon" title="Dismiss" className="shrink-0" onClick={(e) => { e.stopPropagation(); void markNotificationRead(n.id); }}>
                    <Check size={12} />
                  </Button>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between px-3 py-1.5 border-t border-[var(--border-subtle)] text-[0.625rem] text-[var(--text-tertiary)]">
        <span>Click a result to jump to it.</span>
        <button type="button" onClick={onClose} className="hover:text-[var(--text-primary)]">Close</button>
      </div>
    </div>
  );
}
