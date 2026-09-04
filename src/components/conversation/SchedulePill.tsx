"use client";

/**
 * SchedulePill — read-only alarm pill showing a session's active reminder
 * count (dsh schedule overlay, opt-in). Self-hiding when the overlay is off
 * or there are no reminders. Polled on mount + whenever `pollKey` changes
 * (callers pass the turn loading flag so the count refreshes at turn end) —
 * deliberately no standing subscription.
 */

import { useEffect, useState } from "react";
import { AlarmClock } from "lucide-react";
import { cn } from "@/lib/utils";

interface SchedulePillProps {
  sessionId: string;
  pollKey?: unknown;
}

interface ReminderWire {
  id: string;
  prompt: string;
  scheduledAt: string;
  kind: string;
  state: string;
}

export function SchedulePill({ sessionId, pollKey }: SchedulePillProps) {
  const [reminders, setReminders] = useState<ReminderWire[] | null>(null);

  useEffect(() => {
    // Drop the previous session's reminders up front — if this lookup fails
    // or scheduling is unavailable, the pill must hide, not show stale data.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setReminders(null);
    let cancelled = false;
    void (async () => {
      try {
        const res = await window.electron?.session.scheduleList(sessionId);
        if (cancelled || !res || typeof res !== "object" || !("ok" in res) || !res.ok) return;
        setReminders((res as { value: ReminderWire[] }).value);
      } catch {
        // Overlay off / session unknown — stay hidden.
      }
    })();
    return () => { cancelled = true; };
    // pollKey intentionally refetches (turn-end refresh); sessionId switches sessions.
  }, [sessionId, pollKey]);

  if (!reminders || reminders.length === 0) return null;
  const overdue = reminders.filter((r) => r.state === "overdue").length;
  const title = reminders.map((r) => `• ${r.prompt} (${r.state}, ${r.scheduledAt})`).join("\n");

  return (
    <span
      title={title}
      aria-label={`${reminders.length} active reminder${reminders.length === 1 ? "" : "s"}${overdue > 0 ? `, ${overdue} overdue` : ""}`}
      className={cn(
        "flex items-center gap-1 text-[0.643rem] font-semibold px-1.5 py-0.5 rounded-full shrink-0",
        overdue > 0
          ? "bg-[color-mix(in_srgb,var(--danger)_15%,transparent)] text-[var(--danger)]"
          : "bg-[color-mix(in_srgb,var(--accent)_15%,transparent)] text-[var(--accent)]",
      )}
    >
      <AlarmClock size={9} />
      {reminders.length}
    </span>
  );
}
