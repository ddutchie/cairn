/**
 * The 1:1 loop's pure parts (W6): cadence maths for nudges, the prep brief's
 * shape and normaliser, and the Slack profile fields. No Node or Electron
 * APIs. Plan: docs/plans/people-layer.md ("1:1 loop").
 */

import type { Cadence } from "../types/people";
import { nameToEmoji } from "gemoji";

/** Marks the automation row that runs prep briefs (one per workspace, never scheduled, hidden from the list). */
export const PREP_COMMUNITY_ID = "cairn:prep";

export const PREP_BRIEF_VERSION = 1;

const DAY_MS = 86_400_000;

// ── Cadence nudges ────────────────────────────────────────────────────────

/** Days between meetings each cadence expects. */
export const CADENCE_DAYS: Record<Cadence, number> = { weekly: 7, biweekly: 14, monthly: 30 };

/** A nudge appears once the gap passes the cadence by about a third (a skipped week isn't a nudge). */
export const NUDGE_AFTER_DAYS: Record<Cadence, number> = { weekly: 10, biweekly: 18, monthly: 40 };

/** Whole days between two instants (never negative). */
export function daysBetween(fromMs: number, toMs: number): number {
  return Math.max(0, Math.floor((toMs - fromMs) / DAY_MS));
}

/** True when the last 1:1 is further back than the cadence allows. */
export function nudgeDue(cadence: Cadence | undefined, lastMetMs: number | null, nowMs: number): boolean {
  if (!cadence || lastMetMs === null || Number.isNaN(lastMetMs)) return false;
  return daysBetween(lastMetMs, nowMs) >= NUDGE_AFTER_DAYS[cadence];
}

/** "3 weeks", "12 days": the gap as a person would say it. */
export function gapLabel(days: number): string {
  if (days >= 14) {
    const weeks = Math.round(days / 7);
    return `${weeks} weeks`;
  }
  return `${days} days`;
}

export function nudgeTitle(name: string, days: number): string {
  return `No 1:1 with ${name} in ${gapLabel(days)}`;
}

/** Id of a nudge on the Today brief; one per person, so a refresh updates it. */
export function nudgeItemId(personId: string): string {
  return `nudge-${personId}`;
}

// ── Prep brief ────────────────────────────────────────────────────────────

export interface PrepRecentItem {
  /** What they worked on or posted about, in a sentence. Never counts or online time. */
  text: string;
  /** The app it came from ("Slack", "Jira"). */
  source?: string;
  url?: string;
}

export interface PrepSource {
  name: string;
  status: "ok" | "empty" | "error" | "skipped";
  note?: string;
}

export interface PrepBrief {
  version: number;
  /** "gathering" until the run saves its final brief. */
  status: "gathering" | "ready";
  personId: string;
  personName: string;
  /** Local date "YYYY-MM-DD" the brief is for. */
  date: string;
  generatedAt: string;
  /** The meeting this brief is ahead of, when it was started for one. */
  meetingId?: string;
  meetingTitle?: string;
  meetingStartsAt?: string;
  /** One or two sentences: where things stand with them. */
  summary: string;
  /** What they've recently worked on or posted about. */
  recent: PrepRecentItem[];
  /** Things worth following up from earlier meetings and open items. */
  followUps: string[];
  /** Questions worth asking. */
  questions: string[];
  sources: PrepSource[];
  /** The run's closing message, when it had one. */
  note?: string;
  /** Why the run failed, when it did. */
  error?: string;
}

const str = (v: unknown, max = 600): string | undefined => {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t ? t.slice(0, max) : undefined;
};
const strs = (v: unknown, max: number): string[] =>
  (Array.isArray(v) ? v : []).map((x) => str(x)).filter((x): x is string => !!x).slice(0, max);
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const SOURCE_STATUS = new Set(["ok", "empty", "error", "skipped"]);

/**
 * Words that turn a recent-work line into surveillance: counts of messages,
 * time online, response times. The prep describes what someone worked on, so a
 * line that reports activity is dropped, whatever the model wrote.
 */
const COUNTED = "messages?|msgs?|posts?|replies|reactions?|threads?|comments?|commits?|prs?|pull requests?|reviews?|tickets?|issues?|emails?|calls?|meetings?|sessions?|hours?|hrs?|minutes?|mins?";
const NUMBER_WORD = "(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|a dozen|dozens of|hundreds of|dozens|several)";
const ACTIVITY_METRIC = new RegExp([
  // "12 messages", "12 new messages", "twelve messages", "3+ hours"
  `\\b(?:\\d[\\d.,]*\\+?|${NUMBER_WORD})\\s*(?:k\\s+)?(?:(?:new|unread|more|extra|late|total)\\s+)?(?:${COUNTED})\\b`,
  // rates and presence
  `\\b(?:${COUNTED})\\s+(?:a|per|each|every)\\s+(?:day|week|hour|month)\\b`,
  "\\b(?:online|offline|last seen|idle|response times?|reply times?|time to respond|activity (?:level|score|streak|rate)|streak)\\b",
  // "active for 6 hours", "active since 9", "active until midnight", "active today", "active all day", "active late at night"
  "\\bactive\\s+(?:for|since|until|till|from|during|between|today|yesterday|all day|all night|around the clock|late|early|at night|on weekends?|at \\d|\\d)",
  "\\b(?:most|very|highly|extremely|always|constantly)\\s+active\\b",
].join("|"), "i");

/** True for a line that reports activity (counts, time online, response speed) rather than work. */
export function isActivityMetric(text: string): boolean {
  return ACTIVITY_METRIC.test(text);
}

/** Free text with its activity sentences and lines removed; null when nothing is left. */
export function stripActivity(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const kept = text.split(/\n/).map((line) => line.split(/(?<=[.!?])\s+/).filter((s) => !isActivityMetric(s)).join(" ").trim()).filter(Boolean);
  const out = kept.join("\n").trim();
  return out || undefined;
}

/** Normalise the model's `prep_save` input; the person and date come from Cairn, never the model. */
export function normalisePrepInput(
  input: Record<string, unknown>,
  base: Pick<PrepBrief, "personId" | "personName" | "date" | "meetingId" | "meetingTitle" | "meetingStartsAt">,
  now: Date,
): PrepBrief {
  const recent: PrepRecentItem[] = (Array.isArray(input.recent) ? input.recent : [])
    .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
    .flatMap((x) => {
      const text = str(x.text, 400);
      if (!text || isActivityMetric(text)) return [];
      return [{ text, source: str(x.source, 60), url: str(x.url, 500) }];
    })
    .slice(0, 8);
  const sources: PrepSource[] = (Array.isArray(input.sources) ? input.sources : [])
    .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
    .flatMap((x) => {
      const name = str(x.name, 60);
      const status = str(x.status, 10);
      return name && status && SOURCE_STATUS.has(status) ? [{ name, status: status as PrepSource["status"], note: stripActivity(str(x.note, 200)) }] : [];
    })
    .slice(0, 12);
  return {
    version: PREP_BRIEF_VERSION,
    status: "ready",
    ...base,
    generatedAt: now.toISOString(),
    summary: stripActivity(str(input.summary, 500)) ?? "",
    recent,
    followUps: strs(input.followUps, 8).filter((t) => !isActivityMetric(t)),
    questions: strs(input.questions, 6).filter((t) => !isActivityMetric(t)),
    sources,
  };
}

/** Re-read a saved prep brief file; null when it isn't one. */
export function parsePrepBrief(text: string): PrepBrief | null {
  try {
    const o = JSON.parse(text) as Record<string, unknown>;
    const personId = str(o.personId, 80);
    const date = str(o.date, 10);
    if (!personId || !date || !DATE.test(date)) return null;
    const base = {
      personId, personName: str(o.personName, 200) ?? "", date,
      meetingId: str(o.meetingId, 80), meetingTitle: str(o.meetingTitle, 200), meetingStartsAt: str(o.meetingStartsAt, 40),
    };
    const brief = normalisePrepInput(o, base, new Date(str(o.generatedAt, 40) ?? Date.now()));
    return {
      ...brief,
      status: o.status === "gathering" ? "gathering" : "ready",
      generatedAt: str(o.generatedAt, 40) ?? brief.generatedAt,
      note: str(o.note, 1000),
      error: str(o.error, 400),
    };
  } catch {
    return null;
  }
}

// ── Slack profile by reference ────────────────────────────────────────────

/** How long a cached profile counts as fresh. */
export const PROFILE_TTL_MS = 24 * 3_600_000;

/** Volatile fields, read at view time and never written to a person or persona note. */
export interface ProfileFields {
  displayName?: string;
  title?: string;
  timezone?: string;
  pronouns?: string;
  statusText?: string;
  statusEmoji?: string;
}

/** What the person page shows: the last good fields, when they were read, and whether to mark them old. */
export interface PersonProfile {
  fields: ProfileFields;
  /** ISO time the fields were read; absent when never fetched. */
  fetchedAt?: string;
  /** True when the cache is past its TTL or the last refresh failed. */
  stale: boolean;
  /** Why the last refresh failed. */
  error?: string;
}

export function profileIsFresh(fetchedAt: string | undefined, now: number): boolean {
  if (!fetchedAt) return false;
  const t = Date.parse(fetchedAt);
  return !Number.isNaN(t) && now - t < PROFILE_TTL_MS;
}

const pick = (o: unknown, ...keys: string[]): string | undefined => {
  if (!o || typeof o !== "object") return undefined;
  for (const k of keys) {
    const v = (o as Record<string, unknown>)[k];
    if (typeof v === "string" && v.trim()) return v.trim().slice(0, 200);
  }
  return undefined;
};

/** Slack's own names that the standard list (gemoji, GitHub's) spells differently or lacks. */
const SLACK_NAMES: Record<string, string> = {
  spiral_calendar_pad: "🗓️", plane: "✈️", sick: "🤒", lunch: "🍽️", large_green_circle: "🟢", beach_with_umbrella: "🏖️",
  simple_smile: "🙂", slightly_smiling_face: "🙂", face_with_thermometer: "🤒",
};

/** A Slack status emoji as a character. Slack sends `:name:`; the standard shortcodes (and a few Slack-only names) become characters, and custom ones give "" rather than the raw code. */
export function statusEmojiChar(code: string | undefined): string {
  if (!code) return "";
  const name = code.trim().replace(/^:|:$/g, "").replace(/::skin-tone-\d$/, "");
  const known = SLACK_NAMES[name] ?? nameToEmoji[name];
  if (known) return known;
  // Already a character (not a `:name:` code): keep it.
  return /^:[\w+-]+:$/.test(code.trim()) ? "" : code.trim();
}

const LINE_KEYS: Record<string, string> = {
  "display name": "display_name", "real name": "real_name", title: "title", pronouns: "pronouns", timezone: "tz", status: "status_text",
};

/** "Title: Manager" lines as the flattened keys the reader below knows. Null when no known label is present. */
function labelledLines(text: string): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  for (const line of text.split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i < 0) continue;
    const key = LINE_KEYS[line.slice(0, i).trim().toLowerCase()];
    const value = line.slice(i + 1).trim();
    if (key && value) out[key] = value;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Read profile fields out of a Slack connector's reply. Connectors differ (raw
 * Slack API JSON, a `profile` wrapper, flattened fields, or text), so this looks
 * for the usual keys at the top level and under `user` / `profile`.
 */
export function parseSlackProfile(reply: string): ProfileFields | null {
  let data: unknown;
  try { data = JSON.parse(reply); } catch { data = labelledLines(reply); }
  if (!data || typeof data !== "object") return null;
  let root = data as Record<string, unknown>;
  // Slack's own MCP server answers `{"result":"Display Name: …\nTitle: …"}`: labelled text lines inside JSON.
  if (typeof root.result === "string") root = labelledLines(root.result) ?? root;
  const user = (root.user && typeof root.user === "object" ? root.user : root) as Record<string, unknown>;
  const profile = (user.profile && typeof user.profile === "object" ? user.profile : root.profile && typeof root.profile === "object" ? root.profile : {}) as Record<string, unknown>;
  const fields: ProfileFields = {
    displayName: pick(profile, "display_name", "real_name") ?? pick(user, "display_name", "real_name", "name"),
    title: pick(profile, "title") ?? pick(user, "title", "job_title"),
    timezone: pick(user, "tz", "timezone", "tz_label") ?? pick(profile, "tz", "timezone"),
    pronouns: pick(profile, "pronouns") ?? pick(user, "pronouns"),
    statusText: pick(profile, "status_text") ?? pick(user, "status_text", "status"),
    statusEmoji: pick(profile, "status_emoji") ?? pick(user, "status_emoji"),
  };
  const out: ProfileFields = {};
  for (const [k, v] of Object.entries(fields)) if (v) (out as Record<string, string>)[k] = v;
  return Object.keys(out).length ? out : null;
}
