"use client";

/**
 * People view, "Time zones": a 24-hour strip in your own local hours. Each row
 * is a person's 9-to-5 as you live it, your own working day is the shaded band,
 * and a line marks now, so the overlap and who is asleep read at a glance.
 * People with no time zone are listed under the strip.
 */
import React, { useMemo } from "react";
import { Globe } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { FOCUS_RING } from "@/components/ui/button";
import { useNow } from "@/lib/viz/hooks";
import { useOpenPerson } from "@/components/graph/peopleCanvasShared";
import { cn } from "@/lib/utils";
import { PanelHeading } from "@/components/ui/panel";
import { PeopleCanvasPage } from "./PeopleCanvasPage";
import { WORK_END, WORK_START, buildZoneModel, formatDiff } from "../../../shared/people/zones";
import { findMe } from "@/lib/people/network";
import type { PersonSummary } from "../../../shared/types/people-view";

const TICKS = [0, 3, 6, 9, 12, 15, 18, 21, 24];
/** "3:30", from a fractional hour; 24 reads as 24:00. */
const clock = (h: number) => {
  const total = Math.round(h * 60);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
};
const pct = (h: number) => `${(h / 24) * 100}%`;

export function TimeZonesCanvas({ people, selectedId }: { people: readonly PersonSummary[]; selectedId?: string | null }) {
  const open = useOpenPerson();
  const now = useNow(60_000);
  const model = useMemo(() => buildZoneModel(people, findMe(people), new Date(now)), [people, now]);

  if (people.length === 0) return <EmptyState icon={Globe} title="No people yet" description="Add the people you work with and where they are shows up here." className="h-full" />;
  const mine = `${model.me.timezone}${model.me.fromProfile ? "" : " (from this computer; set yours on your own person to change it)"}`;
  return (
    <PeopleCanvasPage lede={`Hours as you live them in ${mine}. Bars are 9:00 to 17:00 where they are; the shaded band is your ${WORK_START}:00 to ${WORK_END}:00.`}>
      <PanelHeading title="Working hours" note={model.rows.length ? String(model.rows.length) : undefined} />
      {model.rows.length === 0 ? (
        <p role="status" className="text-xs text-[var(--text-tertiary)]">Nobody has a time zone yet. Set one on a person&apos;s page.</p>
      ) : (
        <div role="table" aria-label="Working hours by person">
          <div role="row" className="flex items-end gap-3 pb-1">
            <div className="w-28 @3xl:w-40 flex-shrink-0" />
            <div className="relative h-4 flex-1">
              {TICKS.map((h) => (
                <span key={h} className={cn("absolute -translate-x-1/2 text-2xs text-[var(--text-tertiary)] tabular-nums", h % 6 !== 0 && "hidden @2xl:inline")} style={{ left: pct(h) }}>{String(h % 24).padStart(2, "0")}</span>
              ))}
            </div>
            <div className="w-20 @3xl:w-28 flex-shrink-0" />
          </div>
          {model.rows.map((r) => (
            <div key={r.person.id} role="row" className="flex items-center gap-3 py-1">
              <div role="cell" className="w-28 @3xl:w-40 flex-shrink-0">
                <button
                  type="button" onClick={() => open(r.person.id)} aria-pressed={r.person.id === selectedId}
                  className={cn("w-full truncate rounded px-1.5 py-0.5 text-left text-sm", FOCUS_RING, r.person.id === selectedId ? "bg-[var(--accent-dim)] text-[var(--accent)]" : "text-[var(--text-primary)] hover:bg-[var(--surface-2)]")}
                >
                  {r.person.name}
                </button>
              </div>
              <div
                role="cell" className="relative h-5 flex-1 rounded bg-[var(--surface-2)]"
                aria-label={`${r.person.name}: works ${r.spans.map(([a, b]) => `${clock(a)} to ${clock(b)}`).join(" and ")} your time, ${r.overlap} shared hours`}
              >
                <div className="absolute inset-y-0 bg-[var(--accent-dim)]" style={{ left: pct(WORK_START), width: pct(WORK_END - WORK_START) }} />
                {r.spans.map(([a, b]) => (
                  <div key={a} className={cn("absolute inset-y-1 rounded-sm", r.overlap > 0 ? "bg-[var(--accent)]" : "bg-[var(--text-tertiary)]")} style={{ left: pct(a), width: pct(b - a) }} />
                ))}
                <div className="absolute inset-y-0 w-px bg-[var(--text-primary)]" style={{ left: pct(model.nowHour) }} aria-hidden />
              </div>
              <div role="cell" className="w-20 @3xl:w-28 flex-shrink-0 text-xs tabular-nums text-[var(--text-secondary)]">
                {r.localTime} <span className="text-[var(--text-tertiary)]">{formatDiff(r.diffMinutes)}</span>
                {r.asleep ? <span className="ml-1 text-2xs text-[var(--text-tertiary)]">asleep</span> : r.atWork ? <span className="ml-1 text-2xs text-[var(--success)]">at work</span> : null}
                <span className="block text-2xs text-[var(--text-tertiary)]">{r.overlap > 0 ? `${r.overlap}h shared` : "no shared hours"}</span>
              </div>
            </div>
          ))}
        </div>
      )}
      {model.unset.length > 0 && (
        <section aria-label="No time zone set" className="mt-9">
          <PanelHeading title="No time zone set" note={String(model.unset.length)} />
          <ul className="flex flex-wrap gap-1.5">
            {model.unset.map((p) => (
              <li key={p.id}>
                <button type="button" onClick={() => open(p.id)} className={cn("rounded border border-[var(--border-subtle)] px-2 py-1 text-xs text-[var(--text-secondary)] hover:bg-[var(--surface-2)]", FOCUS_RING)}>{p.name}</button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </PeopleCanvasPage>
  );
}
