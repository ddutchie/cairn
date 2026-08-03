/**
 * Cairn — Heartbeat automation schedule parsing
 *
 * Dependency-free schedule model for the heartbeat scheduler. Three kinds:
 *   - cron:  5-field cron expression ("0 9 * * 1-5", step syntax supported)
 *   - every: "N unit" duration ("every 2 hours", "every 30 minutes")
 *   - once:  an ISO datetime ("2026-09-01T09:00:00")
 *
 * Cron next-run is computed by brute-forcing minute-by-minute wall-clock
 * matches using Intl.DateTimeFormat with the configured IANA timezone, so DST
 * transitions are handled correctly without manual offset math. Bounded search
 * (MATCH_HORIZON_MS) so a never-matching cron returns null instead of looping.
 */

export type ScheduleKind = "cron" | "every" | "once";

export interface CronFields {
  minute: number | null;
  hour: number | null;
  /** Day of month, 1-31. */
  dom: number | null;
  /** Month, 1-12. */
  month: number | null;
  /** Day of week, 0-6 (0 = Sunday). */
  dow: number | null;
}

export interface ParsedSchedule {
  kind: ScheduleKind;
  /** Raw schedule string as supplied. */
  expr: string;
  /** Parsed cron fields (kind === "cron"); null when the field is `*`. */
  cron?: CronFields;
  /** Interval in ms (kind === "every"). */
  intervalMs?: number;
  /** Fixed fire time in ms (kind === "once"). */
  atMs?: number;
}

const EVERY_UNITS: Record<string, number> = {
  minute: 60_000,
  minutes: 60_000,
  min: 60_000,
  hour: 3_600_000,
  hours: 3_600_000,
  hr: 3_600_000,
  day: 86_400_000,
  days: 86_400_000,
  week: 604_800_000,
  weeks: 604_800_000,
};

/** Upper bound on brute-force cron search: 366 days ahead. */
export const MATCH_HORIZON_MS = 366 * 86_400_000;

const CRON_RE = /^(\*|\d{1,2}|\*\/\d{1,2}|\d{1,2}(?:-\d{1,2})?(?:,\d{1,2}(?:-\d{1,2})?)*) (\*|\d{1,2}|\*\/\d{1,2}|\d{1,2}(?:-\d{1,2})?(?:,\d{1,2}(?:-\d{1,2})?)*) (\*|\d{1,2}|\*\/\d{1,2}|\d{1,2}(?:-\d{1,2})?(?:,\d{1,2}(?:-\d{1,2})?)*) (\*|\d{1,2}|\*\/\d{1,2}|\d{1,2}(?:-\d{1,2})?(?:,\d{1,2}(?:-\d{1,2})?)*) (\*|\d{1,2}|\*\/\d{1,2}|\d{1,2}(?:-\d{1,2})?(?:,\d{1,2}(?:-\d{1,2})?)*)$/;

/**
 * Parse a user-facing schedule string into a ParsedSchedule.
 * Throws on malformed input.
 */
export function parseSchedule(schedule: string): ParsedSchedule {
  const s = schedule.trim();

  const onceMatch = s.match(/^once\s+(.+)$/i) ?? s.match(/^at\s+(.+)$/i);
  if (onceMatch) {
    const at = new Date(onceMatch[1]);
    if (Number.isNaN(at.getTime())) {
      throw new Error(`Invalid 'once' schedule datetime: "${onceMatch[1]}"`);
    }
    return { kind: "once", expr: s, atMs: at.getTime() };
  }

  const everyMatch = s.match(/^every\s+(\d+(?:\.\d+)?)\s*([a-z]+)$/i);
  if (everyMatch) {
    const n = parseFloat(everyMatch[1]);
    const unit = everyMatch[2].toLowerCase();
    const msPerUnit = EVERY_UNITS[unit];
    if (!msPerUnit || !Number.isFinite(n) || n <= 0) {
      throw new Error(`Invalid 'every' unit: "${everyMatch[2]}"`);
    }
    return { kind: "every", expr: s, intervalMs: n * msPerUnit };
  }

  if (s.startsWith("cron ")) {
    const expr = s.slice(5).trim();
    if (!CRON_RE.test(expr)) throw new Error(`Invalid cron expression: "${expr}"`);
    return { kind: "cron", expr, cron: parseCron(expr) };
  }

  if (CRON_RE.test(s)) {
    return { kind: "cron", expr: s, cron: parseCron(s) };
  }

  throw new Error(`Unrecognized schedule: "${s}". Use "every N minutes|hours|days|weeks", "cron <5-field expr>", or "once <ISO datetime>".`);
}

function parseCron(expr: string): CronFields {
  const [minute, hour, dom, month, dow] = expr.split(/\s+/);
  return {
    minute: parseCronField(minute, 0, 59),
    hour: parseCronField(hour, 0, 23),
    dom: parseCronField(dom, 1, 31),
    month: parseCronField(month, 1, 12),
    dow: parseCronField(dow, 0, 6),
  };
}

/** Returns a concrete numeric value, or null for `*` / step expressions. */
function parseCronField(field: string, min: number, max: number): number | null {
  if (field === "*") return null;
  if (field.startsWith("*/")) {
    const step = parseInt(field.slice(2), 10);
    if (step < 1 || step > max) throw new Error(`Invalid cron step "${field}"`);
    return null; // step handled by the matcher
  }
  for (const part of field.split(",")) {
    const range = part.split("-").map((x) => parseInt(x, 10));
    if (range.some(Number.isNaN)) throw new Error(`Invalid cron field "${field}"`);
    if (range.length === 1) {
      if (range[0] < min || range[0] > max) throw new Error(`Cron value out of range: "${part}"`);
    } else if (range.length === 2) {
      if (range[0] < min || range[1] > max || range[0] > range[1]) {
        throw new Error(`Invalid cron range: "${part}"`);
      }
    } else {
      throw new Error(`Invalid cron field "${field}"`);
    }
  }
  return null;
}

/** Single cron field matcher: `*`, value, `lo-hi` range, comma list, or `step`. */
function match(field: string, value: number): boolean {
  if (field === "*") return true;
  for (const part of field.split(",")) {
    if (part.startsWith("*/")) {
      const step = parseInt(part.slice(2), 10);
      if (step > 0 && value % step === 0) return true;
      continue;
    }
    const [loRaw, hiRaw] = part.split("-");
    const lo = parseInt(loRaw, 10);
    const hi = hiRaw !== undefined ? parseInt(hiRaw, 10) : lo;
    if (value >= lo && value <= hi) return true;
  }
  return false;
}

/**
 * True if any tz-calendar day that overlaps the UTC day starting at `dayStartMs`
 * matches the month / day-of-month / day-of-week cron fields. When both dom and
 * dow are specified, fires when EITHER matches (standard cron semantics).
 */
function dayCouldMatch(dayStartMs: number, tz: string, dom: string, month: string, dow: string): boolean {
  const DAY_MS = 86_400_000;
  const samples = [dayStartMs, dayStartMs + DAY_MS / 2, dayStartMs + DAY_MS - 60_000];
  for (const s of samples) {
    const p = tzParts(new Date(s), tz);
    if (!match(month, p.month)) continue;
    const domOk = match(dom, p.day);
    const dowOk = match(dow, p.weekday);
    if (dom === "*" || dow === "*" ? domOk && dowOk : domOk || dowOk) return true;
  }
  return false;
}

function tzParts(d: Date, tz: string): { minute: number; hour: number; day: number; month: number; weekday: number } {
  try {
    const dtf = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric", month: "numeric", day: "numeric",
      hour: "numeric", minute: "numeric", hour12: false,
      weekday: "short",
    });
    const parts = dtf.formatToParts(d);
    const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";
    let hour = parseInt(get("hour"), 10);
    if (hour === 24) hour = 0; // Intl can emit "24" for midnight with hour12:false
    const weekdayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    return {
      minute: parseInt(get("minute"), 10),
      hour,
      day: parseInt(get("day"), 10),
      month: parseInt(get("month"), 10),
      weekday: weekdayMap[get("weekday")] ?? -1,
    };
  } catch {
    // Unrecognized timezone — fall back to local time.
    return {
      minute: d.getMinutes(),
      hour: d.getHours(),
      day: d.getDate(),
      month: d.getMonth() + 1,
      weekday: d.getDay(),
    };
  }
}

/**
 * Compute the next fire time at-or-after `from` for a parsed schedule.
 * Returns null when no future occurrence exists (e.g. a 'once' in the past, or
 * a cron that never matches within the search horizon).
 */
export function computeNextRun(schedule: ParsedSchedule, from: Date, timezone?: string): Date | null {
  const tz = timezone ?? guessLocalTimezone();
  switch (schedule.kind) {
    case "every":
      return new Date(from.getTime() + (schedule.intervalMs ?? 0));
    case "once": {
      const at = schedule.atMs ?? 0;
      return at >= from.getTime() ? new Date(at) : null;
    }
    case "cron": {
      const raw = schedule.expr.split(/\s+/);
      const [minuteField, hourField, domField, monthField, dowField] = raw as [string, string, string, string, string];
      const fromMs = from.getTime();
      const horizon = fromMs + MATCH_HORIZON_MS;
      const DAY_MS = 86_400_000;
      const startDay = Math.floor(fromMs / DAY_MS) * DAY_MS;

      for (let dayStart = startDay; dayStart <= horizon; dayStart += DAY_MS) {
        // Cheap pre-filter: does any tz-calendar day within this UTC day match
        // month/day-of-month/day-of-week? Samples start/noon/end so a tz midnight
        // crossing can't hide a matching calendar day. Saves ~1440x on the common
        // non-matching-day path (e.g. "0 0 30 2 *" never matches → ~366 checks).
        if (!dayCouldMatch(dayStart, tz, domField, monthField, dowField)) continue;

        const dayEnd = dayStart + DAY_MS;
        let t = Math.max(dayStart, fromMs + 60_000);
        for (; t < dayEnd; t += 60_000) {
          if (t > horizon) return null;
          const p = tzParts(new Date(t), tz);
          if (match(minuteField, p.minute) && match(hourField, p.hour)) {
            return new Date(t);
          }
        }
      }
      return null;
    }
  }
}

let cachedTz: string | undefined;
function guessLocalTimezone(): string {
  if (!cachedTz) {
    try {
      cachedTz = Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";
    } catch {
      cachedTz = "UTC";
    }
  }
  return cachedTz;
}
