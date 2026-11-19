"use client";

/**
 * Cadence nudges in Today's "Need you" lane (W6): "No 1:1 with X in 3 weeks",
 * for people who have a cadence and whose last 1:1 is further back than it
 * allows. Cairn works them out when Today loads (they are not part of the
 * saved brief), so one disappears as soon as the meeting happens. "Done" hides
 * it for the day; "Open" goes to the person's page.
 */

import React, { useState } from "react";
import { CalendarClock, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { todayClient } from "@/lib/ipc/automations";
import { useCairnStore } from "@/store";
import { localDate, type TodayNudge } from "../../../shared/today/brief";

export function TodayNudges({ nudges, workspaceId }: { nudges: TodayNudge[]; workspaceId: string }) {
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const open = useCairnStore((s) => s.openPerson);
  const shown = nudges.filter((n) => !hidden.has(n.id));
  if (shown.length === 0) return null;
  const done = (id: string) => {
    setHidden((h) => new Set(h).add(id));
    todayClient.mark(workspaceId, localDate(new Date()), { done: { [id]: true } }).catch(() => { /* hidden for now; shows again on reload */ });
  };
  return (
    <>
      {shown.map((n) => (
        <div key={n.id} className="flex items-center gap-2.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-2)] p-2.5 shadow-elev-1">
          <CalendarClock size={14} className="flex-shrink-0 text-[var(--text-tertiary)]" aria-hidden />
          <p className="min-w-0 flex-1 text-sm text-[var(--text-primary)]">{n.title}</p>
          <Button variant="outline" size="sm" onClick={() => open(n.personId)}>Open</Button>
          <IconButton label={`Done: ${n.title}`} onClick={() => done(n.id)}><Check size={13} /></IconButton>
        </div>
      ))}
    </>
  );
}
