"use client";

/**
 * The Today history rail: one tick per saved day (newest at the top), its
 * length set by how much needed you that day, with a dot for each version a
 * same-day refresh replaced. Hovering a tick previews that brief; clicking it
 * opens it read-only. Weeks are split by a gap with the Monday's date.
 */

import { History } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button, FOCUS_RING } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import type { TodayHistoryEntry } from "../../../shared/today/brief";
import type { TodayComparison, TodayHistoryDay } from "../../../shared/today/history";
import { TODAY_KEEP_DAYS_LABEL, dayLabel, timeLabel } from "./today-history-labels";

export function TodayRail({ days, liveDate, selectedKey, onSelect, onPeek }: {
  days: TodayHistoryDay[];
  /** The live brief's date: its tick stands for "now". */
  liveDate: string | null;
  /** The version open read-only, or null for the live brief. */
  selectedKey: string | null;
  onSelect: (key: string | null) => void;
  onPeek: (on: boolean) => void;
}) {
  return (
    <nav
      aria-label="Earlier briefs"
      className="sticky top-0 shrink-0 w-14 flex flex-col items-center gap-0.5 py-3 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface)]"
      onMouseLeave={() => onPeek(false)}
    >
      <button
        type="button"
        onClick={() => onSelect(null)}
        className={cn("text-2xs mb-1.5 px-1.5 rounded", FOCUS_RING, selectedKey === null ? "text-[var(--accent)]" : "text-[var(--text-tertiary)] hover:text-[var(--text-primary)]")}
      >
        Now
      </button>
      {days.map((day, i) => {
        const live = day.date === liveDate;
        const selected = selectedKey === null ? live : day.latest.key === selectedKey || day.versions.some((v) => v.key === selectedKey);
        const monday = new Date(`${day.date}T00:00`).getDay() === 1;
        return (
          <div key={day.date} className="contents">
            <RailTick day={day} live={live} selected={selected} onSelect={onSelect} onPeek={onPeek} />
            {/* A week ends at its Monday (newest first): its date on its own line, then a gap. */}
            {monday && (
              <div className={cn("w-11 shrink-0 font-mono text-2xs leading-none text-[var(--text-tertiary)] text-right pr-1.5", i < days.length - 1 ? "pt-0.5 pb-2" : "pt-0.5")} aria-hidden>
                {new Date(`${day.date}T00:00`).toLocaleDateString(undefined, { day: "numeric", month: "short" })}
              </div>
            )}
          </div>
        );
      })}
      <div className="mt-3 text-2xs text-center leading-tight text-[var(--text-tertiary)]">{TODAY_KEEP_DAYS_LABEL}</div>
    </nav>
  );
}

function RailTick({ day, live, selected, onSelect, onPeek }: {
  day: TodayHistoryDay; live: boolean; selected: boolean;
  onSelect: (key: string | null) => void; onPeek: (on: boolean) => void;
}) {
  const e = day.latest;
  const width = selected ? 26 : Math.min(30, 8 + e.counts.need * 2.4);
  return (
    <Tooltip side="left" delayDuration={120} content={<RailPreview entry={e} versions={day.versions.length} live={live} />}>
      <button
        type="button"
        aria-label={`${dayLabel(day.date)}: ${e.headline}`}
        aria-current={selected ? "true" : undefined}
        onClick={() => onSelect(live ? null : e.key)}
        onMouseEnter={() => onPeek(true)}
        onFocus={() => onPeek(true)}
        onBlur={() => onPeek(false)}
        className={cn("group relative w-11 h-4 shrink-0 flex items-center justify-end gap-[3px] pr-1.5 rounded", FOCUS_RING)}
      >
        {day.versions.slice(0, 3).map((v) => (
          <span key={v.key} className="size-1 rounded-full bg-[var(--text-tertiary)]" aria-hidden />
        ))}
        <span
          aria-hidden
          className={cn(
            "h-0.5 rounded-full transition-[width,background-color] duration-150",
            selected ? "bg-[var(--accent)]" : "bg-[var(--border)] group-hover:bg-[var(--accent)]",
          )}
          style={{ width }}
        />
      </button>
    </Tooltip>
  );
}

function RailPreview({ entry, versions, live }: { entry: TodayHistoryEntry; versions: number; live: boolean }) {
  const c = entry.counts;
  return (
    <div className="max-w-64 py-0.5">
      <div className="text-2xs text-[var(--text-tertiary)]">
        {live ? "Today" : dayLabel(entry.date)} · {timeLabel(entry.generatedAt)}
        {versions > 0 && ` · ${versions} earlier ${versions === 1 ? "version" : "versions"} that day`}
      </div>
      <div className="font-display text-sm text-[var(--text-primary)] leading-snug my-1">{entry.headline}</div>
      <div className="text-2xs text-[var(--text-secondary)]">
        {c.need} need you · {c.prepared} {c.prepared === 1 ? "draft" : "drafts"}{c.carried ? ` · ${c.carried} carried in` : ""}
      </div>
    </div>
  );
}

/** Shown over a brief opened from the rail: what it is, how its items fared since, and the way back. */
export function TodayPastBanner({ date, generatedAt, versions, selectedKey, comparison, hasLive, onPick, onBack }: {
  date: string;
  generatedAt: string;
  /** That day's saved versions, newest first (the day's last brief included). */
  versions: Array<{ key: string; generatedAt: string }>;
  selectedKey: string;
  comparison: TodayComparison;
  hasLive: boolean;
  onPick: (key: string) => void;
  onBack: () => void;
}) {
  const chip = (n: number, text: string) => (
    <span className="text-2xs px-2 py-px rounded-full border border-[var(--border)] text-[var(--text-secondary)]">
      <span className="font-mono text-[var(--text-primary)] mr-1">{n}</span>{text}
    </span>
  );
  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-2.5 px-3 py-2 mb-4 rounded-xl text-xs border"
      style={{
        borderColor: "color-mix(in srgb, var(--accent) 35%, transparent)",
        background: "color-mix(in srgb, var(--accent) 9%, var(--surface))",
      }}
    >
      <History size={13} className="text-[var(--accent)] shrink-0" aria-hidden />
      <span className="font-medium text-[var(--text-primary)]">Looking back at {dayLabel(date)}, {timeLabel(generatedAt)}</span>
      <span className="text-[var(--text-tertiary)]">Read-only</span>
      {hasLive && (
        <span className="flex flex-wrap gap-1.5">
          {chip(comparison.carried.size, "still open today")}
          {chip(comparison.resolved.size, "resolved since")}
          {chip(comparison.fresh, "new today")}
        </span>
      )}
      {versions.length > 1 && (
        <span className="flex items-center gap-1" aria-label="Versions that day">
          {versions.map((v) => (
            <button
              key={v.key}
              type="button"
              aria-pressed={v.key === selectedKey}
              onClick={() => onPick(v.key)}
              className={cn(
                "font-mono text-2xs px-1.5 py-px rounded border",
                FOCUS_RING,
                v.key === selectedKey
                  ? "border-[var(--accent)] text-[var(--accent)]"
                  : "border-[var(--border)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]",
              )}
            >
              {timeLabel(v.generatedAt)}
            </button>
          ))}
        </span>
      )}
      <Button variant="outline" size="sm" className="ml-auto" onClick={onBack}>
        Back to today <kbd className="font-mono text-2xs text-[var(--text-tertiary)] ml-1">Esc</kbd>
      </Button>
    </div>
  );
}
