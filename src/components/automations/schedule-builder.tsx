"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { DatePicker } from "@/components/ui/date-picker";
import { TimePicker } from "@/components/ui/time-picker";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Clock } from "lucide-react";
import type { ScheduleKind } from "@/store/slices/automations";

type ScheduleMode = "every" | "daily" | "weekly" | "monthly" | "once" | "cron";

const MODES: Array<{ value: ScheduleMode; label: string }> = [
  { value: "every", label: "Interval" },
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
  { value: "monthly", label: "Monthly" },
  { value: "once", label: "Once" },
  { value: "cron", label: "Custom" },
];

const INTERVAL_UNITS = ["minutes", "hours", "days", "weeks"] as const;

const WEEKDAYS = [
  { n: 0, short: "Sun", full: "Sunday" },
  { n: 1, short: "Mon", full: "Monday" },
  { n: 2, short: "Tue", full: "Tuesday" },
  { n: 3, short: "Wed", full: "Wednesday" },
  { n: 4, short: "Thu", full: "Thursday" },
  { n: 5, short: "Fri", full: "Friday" },
  { n: 6, short: "Sat", full: "Saturday" },
] as const;

const MONTH_DAYS = Array.from({ length: 31 }, (_, i) => i + 1);

interface ScheduleBuilderProps {
  initialKind: ScheduleKind;
  initialExpr: string;
  timezone?: string | null;
  onChange: (kind: ScheduleKind, expr: string) => void;
}

function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}

function todayIso(): string {
  const now = new Date();
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
}

/** "HH:MM" → [hours, minutes]. */
function timeParts(timeStr: string): [number, number] {
  const [h, m] = timeStr.split(":").map((x) => parseInt(x, 10));
  return [Number.isFinite(h) ? h : 9, Number.isFinite(m) ? m : 0];
}

function exprFor(mode: ScheduleMode, s: {
  intervalN: number; intervalUnit: string;
  timeStr: string; days: Set<number>; dayOfMonth: number;
  onceDate: string; onceTime: string; cronExpr: string;
}): { kind: ScheduleKind; expr: string } {
  const [h, m] = timeParts(s.timeStr);
  switch (mode) {
    case "every":
      return { kind: "every", expr: `every ${s.intervalN} ${s.intervalUnit}` };
    case "daily":
      return { kind: "cron", expr: `${pad2(m)} ${pad2(h)} * * *` };
    case "weekly": {
      const dow = [...s.days].sort((a, b) => a - b).join(",");
      return { kind: "cron", expr: `${pad2(m)} ${pad2(h)} * * ${dow}` };
    }
    case "monthly":
      return { kind: "cron", expr: `${pad2(m)} ${pad2(h)} ${s.dayOfMonth} * *` };
    case "once":
      return { kind: "once", expr: `once ${s.onceDate || todayIso()}T${s.onceTime}` };
    case "cron":
      return { kind: "cron", expr: s.cronExpr.trim() };
  }
}

/**
 * Reverse-map an existing schedule back into the friendly builder state (used
 * when editing). Unknown cron shapes fall through to the Custom mode untouched.
 */
function builderFromSchedule(kind: ScheduleKind, expr: string): {
  mode: ScheduleMode;
  intervalN: number; intervalUnit: string;
  timeStr: string; days: Set<number>; dayOfMonth: number;
  onceDate: string; onceTime: string; cronExpr: string;
} {
  const base = {
    intervalN: 24, intervalUnit: "hours" as string,
    timeStr: "09:00", days: new Set([1, 2, 3, 4, 5]), dayOfMonth: 1,
    onceDate: "", onceTime: "09:00", cronExpr: expr,
  };

  if (kind === "every") {
    const m = expr.match(/^every\s+(\d+(?:\.\d+)?)\s*([a-z]+)$/i);
    if (m) {
      const unit = m[2].toLowerCase();
      return { ...base, mode: "every", intervalN: Math.round(parseFloat(m[1])), intervalUnit: unit };
    }
    return { ...base, mode: "every" };
  }

  if (kind === "once") {
    const m = expr.match(/^once\s+(.+)$/i) ?? expr.match(/^at\s+(.+)$/i);
    const date = new Date(m ? m[1] : expr);
    if (m && !Number.isNaN(date.getTime())) {
      return {
        ...base, mode: "once",
        onceDate: `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`,
        onceTime: `${pad2(date.getHours())}:${pad2(date.getMinutes())}`,
      };
    }
    return { ...base, mode: "once" };
  }

  // cron — try to classify simple shapes.
  const parts = expr.split(/\s+/);
  if (parts.length === 5) {
    const [min, hour, dom, , dow] = parts;
    const domStar = dom === "*";
    const dowStar = dow === "*";
    const timeStr = `${pad2(parseInt(hour, 10) || 0)}:${pad2(parseInt(min, 10) || 0)}`;
    const onlyStars = (f: string) => /^[*]$/.test(f);
    const specificDow = dow.split(",").map((x) => parseInt(x, 10)).filter((n) => Number.isFinite(n));
    const specificDom = !domStar && !onlyStars(dom) ? parseInt(dom.split(",")[0], 10) : NaN;

    if (onlyStars(min) && onlyStars(hour)) {
      return { ...base, mode: "cron", cronExpr: expr };
    }
    if (domStar && dowStar) {
      return { ...base, mode: "daily", timeStr };
    }
    if (domStar && specificDow.length > 0 && specificDow.every((d) => d >= 0 && d <= 6)) {
      return { ...base, mode: "weekly", timeStr, days: new Set(specificDow) };
    }
    if (dowStar && Number.isFinite(specificDom) && specificDom >= 1 && specificDom <= 31) {
      return { ...base, mode: "monthly", timeStr, dayOfMonth: specificDom };
    }
  }

  return { ...base, mode: "cron", cronExpr: expr };
}

export function ScheduleBuilder({ initialKind, initialExpr, timezone, onChange }: ScheduleBuilderProps) {
  const init = useMemo(() => builderFromSchedule(initialKind, initialExpr), [initialKind, initialExpr]);
  const [mode, setMode] = useState<ScheduleMode>(init.mode);
  const [intervalN, setIntervalN] = useState(init.intervalN);
  const [intervalUnit, setIntervalUnit] = useState<string>(init.intervalUnit);
  const [timeStr, setTimeStr] = useState(init.timeStr);
  const [days, setDays] = useState<Set<number>>(init.days);
  const [dayOfMonth, setDayOfMonth] = useState(init.dayOfMonth);
  const [onceDate, setOnceDate] = useState(init.onceDate);
  const [onceTime, setOnceTime] = useState(init.onceTime);
  const [cronExpr, setCronExpr] = useState(init.cronExpr);

  function handleModeChange(v: ScheduleMode) {
    setMode(v);
    // Once mode needs a day — preselect today when it's opened without one.
    if (v === "once" && !onceDate) setOnceDate(todayIso());
  }

  const derived = useMemo(() => exprFor(mode, {
    intervalN, intervalUnit, timeStr, days, dayOfMonth, onceDate, onceTime, cronExpr,
  }), [mode, intervalN, intervalUnit, timeStr, days, dayOfMonth, onceDate, onceTime, cronExpr]);

  // Lift the derived expression up to the dialog.
  useEffect(() => {
    onChange(derived.kind, derived.expr);
  }, [derived.kind, derived.expr, onChange]);

  // Live "next run" preview via the main-process schedule parser.
  const [preview, setPreview] = useState<{ ok: boolean; text: string }>({ ok: true, text: "" });
  const previewTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const previewFn = typeof window !== "undefined" ? window.electron?.automation?.preview : undefined;
    if (!previewFn) return;
    if (previewTimer.current) clearTimeout(previewTimer.current);
    previewTimer.current = setTimeout(() => {
      void (async () => {
        try {
          const res = (await previewFn(derived.kind, derived.expr, timezone)) as
            | { nextRunAt: string | null }
            | { error: string };
          if ("error" in res) setPreview({ ok: false, text: res.error });
          else setPreview({ ok: true, text: res.nextRunAt ? `Next run ${formatWhen(res.nextRunAt)}` : "No next run (schedule in the past?)" });
        } catch {
          setPreview({ ok: false, text: "Could not preview schedule" });
        }
      })();
    }, 400);
    return () => { if (previewTimer.current) clearTimeout(previewTimer.current); };
  }, [derived.kind, derived.expr, timezone]);

  function toggleDay(n: number) {
    setDays((prev) => {
      const next = new Set(prev);
      if (next.has(n)) next.delete(n); else next.add(n);
      return next;
    });
  }

  return (
    <div className="space-y-3">
      <div>
        <span className="text-xs text-[var(--text-secondary)]">Schedule</span>
        <div className="mt-1.5">
          <SegmentedControl
            options={MODES.map((m) => ({ value: m.value, label: m.label }))}
            value={mode}
            onChange={(v) => handleModeChange(v as ScheduleMode)}
          />
        </div>
      </div>

      <div className="text-xs">
        {mode === "every" && (
          <div className="flex items-center gap-2">
            <Input
              type="number" min={1} value={intervalN}
              onChange={(e) => setIntervalN(Math.max(1, parseInt(e.target.value, 10) || 1))}
              className="w-20"
            />
            <select
              value={intervalUnit}
              onChange={(e) => setIntervalUnit(e.target.value)}
              className="rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-2 text-sm text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)]"
            >
              {INTERVAL_UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
            </select>
            <span className="text-[var(--text-secondary)]">— repeats on that interval</span>
          </div>
        )}

        {mode === "daily" && (
          <div className="flex items-center gap-2">
            <span className="text-[var(--text-secondary)]">Every day at</span>
            <TimeInput value={timeStr} onChange={setTimeStr} />
          </div>
        )}

        {mode === "weekly" && (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-1.5">
              {WEEKDAYS.map((d) => {
                const active = days.has(d.n);
                return (
                  <button
                    key={d.n}
                    type="button"
                    onClick={() => toggleDay(d.n)}
                    title={d.full}
                    className={cn(
                      "px-2 py-1 rounded-md text-xs border transition-colors",
                      active
                        ? "bg-[var(--accent-dim)] border-[var(--accent)] text-[var(--accent)]"
                        : "bg-[var(--surface)] border-[var(--border)] text-[var(--text-tertiary)] hover:border-[var(--muted)]"
                    )}
                  >
                    {d.short}
                  </button>
                );
              })}
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[var(--text-secondary)]">at</span>
              <TimeInput value={timeStr} onChange={setTimeStr} />
              {days.size === 0 && <span className="text-[var(--danger)]">Pick at least one day</span>}
            </div>
          </div>
        )}

        {mode === "monthly" && (
          <div className="flex items-center gap-2">
            <span className="text-[var(--text-secondary)]">On day</span>
            <select
              value={dayOfMonth}
              onChange={(e) => setDayOfMonth(parseInt(e.target.value, 10))}
              className="rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-2 text-sm text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)]"
            >
              {MONTH_DAYS.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
            <span className="text-[var(--text-secondary)]">at</span>
            <TimeInput value={timeStr} onChange={setTimeStr} />
          </div>
        )}

        {mode === "once" && (
          <div className="flex items-center gap-2">
            <DatePicker disablePast value={onceDate || undefined} onChange={(v) => setOnceDate(v ?? "")} />
            <span className="text-[var(--text-secondary)]">at</span>
            <TimeInput value={onceTime} onChange={setOnceTime} />
          </div>
        )}

        {mode === "cron" && (
          <div>
            <Input
              value={cronExpr}
              onChange={(e) => setCronExpr(e.target.value)}
              placeholder="0 9 * * 1-5"
              className="font-mono"
            />
            <p className="text-[0.714rem] text-[var(--text-tertiary)] mt-1">
              minute hour day-of-month month day-of-week (0=Sun). For other cases use the friendly modes above.
            </p>
          </div>
        )}
      </div>

      <div className="flex items-center gap-1.5 text-xs">
        <Clock size={11} className="text-[var(--text-tertiary)] shrink-0" />
        <code className="font-mono text-[0.714rem] text-[var(--text-tertiary)]">{derived.expr}</code>
        {preview.text && (
          <span className={cn("ml-auto", preview.ok ? "text-[var(--ok,#22c55e)]" : "text-[var(--danger)]")}>
            {preview.text}
          </span>
        )}
      </div>
    </div>
  );
}

function TimeInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="w-32">
      <TimePicker value={value} onChange={onChange} />
    </div>
  );
}

function formatWhen(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "—";
  const diff = t - Date.now();
  const abs = Math.abs(diff);
  const mins = Math.round(abs / 60_000);
  const hrs = Math.round(abs / 3_600_000);
  const days = Math.round(abs / 86_400_000);
  const future = diff >= 0;
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m ${future ? "away" : "ago"}`;
  if (hrs < 24) return `${hrs}h ${future ? "away" : "ago"}`;
  if (days < 30) return `${days}d ${future ? "away" : "ago"}`;
  return new Date(iso).toLocaleDateString();
}
