"use client";

/**
 * People view, "Rhythm": who you are due to see, against the cadence you set
 * for each person. Status is a dot and a word. Nothing here measures anyone's
 * activity; it is your own intent (the cadence) against when you last met.
 */
import React, { useMemo } from "react";
import { CalendarClock } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { PanelHeading } from "@/components/ui/panel";
import { StatusDot } from "@/components/ui/status-dot";
import { FOCUS_RING } from "@/components/ui/button";
import { useOpenPerson } from "@/components/graph/peopleCanvasShared";
import { useNow } from "@/lib/viz/hooks";
import { cn } from "@/lib/utils";
import { CADENCE_LABELS } from "./people-model";
import { buildRhythm, type RhythmRow, type RhythmState } from "../../../shared/people/rhythm";
import type { PersonSummary } from "../../../shared/types/people-view";

const COLOR: Record<RhythmState, string> = {
  overdue: "var(--danger)", soon: "var(--warning)", ok: "var(--success)", never: "var(--text-tertiary)",
};

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

function stateLabel(r: RhythmRow): string {
  switch (r.state) {
    case "never": return "No meeting yet";
    case "overdue": return `Overdue by ${plural(r.daysOver, "day")}`;
    case "soon": return r.daysOver === 0 ? "Due today" : `Due in ${plural(-r.daysOver, "day")}`;
    case "ok": return r.daysOver > 0 ? "Next meeting is booked in time" : `${plural(-r.daysOver, "day")} to go`;
  }
}

export function RhythmCanvas({ people, selectedId }: { people: readonly PersonSummary[]; selectedId?: string | null }) {
  const open = useOpenPerson();
  const now = useNow(3_600_000);
  const model = useMemo(() => buildRhythm(people, new Date(now)), [people, now]);

  if (people.length === 0) return <EmptyState icon={CalendarClock} title="No people yet" description="Add the people you work with and set how often you want to meet." className="h-full" />;
  const { counts } = model;
  const note = [
    counts.never ? `${counts.never} without a meeting` : "", counts.overdue ? `${counts.overdue} overdue` : "",
    counts.soon ? `${counts.soon} due soon` : "", counts.ok ? `${counts.ok} on track` : "",
  ].filter(Boolean).join(", ");

  return (
    <div className="h-full overflow-y-auto px-6 py-5">
      <div className="max-w-[1240px]">
        <p className="mb-7 max-w-[62ch] text-base leading-relaxed text-[var(--text-secondary)] text-pretty">
          Who you are due to see, measured against the cadence you set for each person.
        </p>
        <section aria-label="Meeting rhythm">
          <PanelHeading title="Meeting rhythm" note={note || undefined} />
          {model.rows.length === 0 ? (
            <p className="text-xs text-[var(--text-tertiary)]">Nobody has a cadence yet. Set one on a person&apos;s page and they show up here.</p>
          ) : (
            <ul>
              {model.rows.map((r) => {
                const pos = r.ratio === null ? 0 : Math.min(r.ratio, 2) / 2;
                const booked = r.bookedInDays !== null && r.sinceDays !== null ? Math.min(2, (r.sinceDays + r.bookedInDays) / r.cadenceDays) / 2 : null;
                return (
                  <li key={r.person.id} className="border-b border-[var(--border-subtle)] last:border-0">
                    <button
                      type="button" onClick={() => open(r.person.id)} aria-pressed={r.person.id === selectedId}
                      className={cn(
                        "grid w-full items-center gap-x-4 gap-y-1 rounded-md px-2 py-2 text-left transition-colors @4xl:grid-cols-[11rem_1fr_11rem] hover:bg-[var(--surface-2)]", FOCUS_RING,
                        r.person.id === selectedId && "bg-[var(--accent-dim)]",
                      )}
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-sm">{r.person.name}</span>
                        <span className="block truncate text-2xs text-[var(--text-tertiary)]">
                          {CADENCE_LABELS[r.person.cadence!]}{r.sinceDays === null ? "" : `, last met ${plural(r.sinceDays, "day")} ago`}
                        </span>
                      </span>
                      <span className="relative block h-2 rounded-full bg-[var(--surface-3)]" aria-hidden>
                        <span className="absolute inset-y-0 left-0 rounded-full bg-[var(--stone-2)]" style={{ width: `${pos * 100}%` }} />
                        <span className="absolute -inset-y-1 w-px bg-[var(--text-primary)] opacity-60" style={{ left: "50%" }} />
                        {booked !== null && (
                          <span className="absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-[var(--surface)] bg-[var(--accent)]" style={{ left: `${booked * 100}%` }} />
                        )}
                      </span>
                      <span className="min-w-0 text-xs" style={{ color: COLOR[r.state] }}>
                        <span className="inline-flex items-center gap-1.5"><StatusDot color={COLOR[r.state]} />{stateLabel(r)}</span>
                        {r.bookedInDays !== null && <span className="block text-2xs text-[var(--text-tertiary)]">{r.bookedInDays === 0 ? "Meeting booked today" : `Meeting booked in ${plural(r.bookedInDays, "day")}`}</span>}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
        {model.noCadence.length > 0 && (
          <section aria-label="No cadence set" className="mt-9">
            <PanelHeading title="No cadence set" note={String(model.noCadence.length)} />
            <ul className="flex flex-wrap gap-1.5">
              {model.noCadence.map((p) => (
                <li key={p.id}>
                  <button type="button" onClick={() => open(p.id)} className={cn("rounded border border-[var(--border-subtle)] px-2 py-1 text-xs text-[var(--text-secondary)] hover:bg-[var(--surface-2)]", FOCUS_RING)}>{p.name}</button>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-2xs text-[var(--text-tertiary)]">Set how often you want to meet someone on their page and they appear above.</p>
          </section>
        )}
      </div>
    </div>
  );
}
