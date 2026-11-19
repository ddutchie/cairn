/**
 * People layer parsers: names, attendee values, meeting dates, body metadata
 * lines and checklist owners. Pure (no Node, no DB), so desktop, the MCP
 * runtime and mobile share one copy. Plan: docs/plans/people-layer.md.
 */

export const MAX_RELATIONSHIP_LABEL = 40;

/**
 * A relationship label is one short phrase that qualifies its type ("executive
 * sponsor" on a stakeholder), never a list and never another type. Returns the
 * cleaned label (undefined when empty) or an error the writer can act on.
 */
export function cleanRelationshipLabel(raw: unknown): { label?: string; error?: string } {
  if (typeof raw !== "string") return {};
  const label = raw.replace(/\s+/g, " ").trim();
  if (!label) return {};
  if (/[,;\n]/.test(raw)) return { error: "A relationship label is one short phrase. For several relationships, pass one entry each, every one with its own type." };
  if (label.length > MAX_RELATIONSHIP_LABEL) return { error: `A relationship label is at most ${MAX_RELATIONSHIP_LABEL} characters.` };
  return { label };
}

export const PROFILE_FIELDS = ["title", "team", "location", "timezone"] as const;
export type ProfileField = (typeof PROFILE_FIELDS)[number];
export const MAX_PROFILE_FIELD = 80;

/** Whether `tz` is an IANA time zone the runtime knows. Accepts anything where Intl can't check. */
function knownTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch (err) {
    return !(err instanceof RangeError);
  }
}

/**
 * A profile field (role, team, place, time zone) as one short line. Empty is
 * "no value"; a time zone must be an IANA name like Europe/Berlin.
 */
export function cleanProfileField(field: ProfileField, raw: unknown): { value?: string; error?: string } {
  if (typeof raw !== "string") return {};
  const value = raw.replace(/\s+/g, " ").trim();
  if (!value) return {};
  if (value.length > MAX_PROFILE_FIELD) return { error: `${field} is at most ${MAX_PROFILE_FIELD} characters.` };
  if (field === "timezone" && !knownTimezone(value)) return { error: `"${value}" isn't a time zone. Use an IANA name like Europe/Berlin.` };
  return { value };
}

/** A person reference as written somewhere: a name, an email, or both. */
export interface AttendeeRef {
  name?: string;
  email?: string;
}

/**
 * Comparison key for names: case-folded, accents removed, whitespace collapsed.
 * "Sébastien  Morel" and "sebastien morel" match; "Sebastian" does not.
 */
export function foldName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

export function isEmail(s: string): boolean {
  return EMAIL.test(s.trim());
}

/**
 * Parse one attendee value from frontmatter, a tool argument or a metadata line:
 *   "[[Chris Sponagle]]", "[[Chris Sponagle|Chris]]", "[[Folder/Chris Sponagle]]",
 *   "chris@example.com", "Chris Sponagle <chris@example.com>", "Chris Sponagle".
 * Wikilinks resolve to the link target (the persona note title), not the alias.
 * Returns null for empty or unusable values.
 */
export function parseAttendeeValue(raw: unknown): AttendeeRef | null {
  if (typeof raw !== "string") return null;
  let s = raw.trim().replace(/^@/, "");
  if (!s) return null;

  const link = /^\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]$/.exec(s);
  if (!link && s.startsWith("[[")) return null;
  if (link) {
    const target = link[1].trim();
    const name = target.split("/").pop()!.replace(/\.md$/i, "").trim();
    return name ? { name } : null;
  }

  const angle = /^(.*?)\s*<([^<>]+)>$/.exec(s);
  if (angle && isEmail(angle[2])) {
    const name = angle[1].replace(/^["']|["']$/g, "").trim();
    return { email: angle[2].trim().toLowerCase(), ...(name ? { name } : {}) };
  }

  if (isEmail(s)) return { email: s.toLowerCase() };
  s = s.replace(/^["']|["']$/g, "").replace(/\*\*/g, "").trim();
  return s ? { name: s } : null;
}

/** Parse a list of attendee values (array, or a single comma/semicolon-separated string). */
export function parseAttendeeList(raw: unknown): AttendeeRef[] {
  const items: unknown[] = Array.isArray(raw)
    ? raw
    : typeof raw === "string"
      ? splitAttendeeValues(raw)
      : [];
  const out: AttendeeRef[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const ref = parseAttendeeValue(item);
    if (!ref) continue;
    const key = ref.email ?? foldName(ref.name ?? "");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
  }
  return out;
}

/**
 * Split "A, B and C; [[D, Jr]] & E" on commas, semicolons, " and " and "&",
 * never inside a wikilink. Returns the raw values, trimmed.
 */
export function splitAttendeeValues(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const two = s.slice(i, i + 2);
    if (two === "[[") { depth++; cur += two; i++; continue; }
    if (two === "]]") { depth = Math.max(0, depth - 1); cur += two; i++; continue; }
    const ch = s[i];
    if (depth === 0) {
      if (ch === "," || ch === ";" || ch === "&") { parts.push(cur); cur = ""; continue; }
      const and = /^\s+and\s+/i.exec(s.slice(i));
      if (and) { parts.push(cur); cur = ""; i += and[0].length - 1; continue; }
    }
    cur += ch;
  }
  parts.push(cur);
  return parts.map((p) => p.trim()).filter(Boolean);
}

/** A calendar date that exists ("2026-02-30" doesn't). */
function isRealDate(y: number, m: number, d: number): boolean {
  // Date.UTC maps years 0-99 to 1900-1999; setUTCFullYear doesn't.
  const t = new Date(0);
  t.setUTCFullYear(y, m - 1, d);
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

/**
 * Normalise a meeting date from frontmatter or text to ISO 8601.
 * Accepts a JS Date (YAML parsers turn `2026-11-11` into one), "2026-11-11",
 * "2026-11-11 15:00", "2026-11-11T15:00:00Z". Date-only values become midnight
 * UTC so they sort with timed meetings. Returns null when unparseable.
 */
export function parseMeetingDate(raw: unknown): string | null {
  if (raw instanceof Date) return Number.isNaN(raw.getTime()) ? null : raw.toISOString();
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  const ymd = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!ymd || !isRealDate(Number(ymd[1]), Number(ymd[2]), Number(ymd[3]))) return null;
  if (s.length === 10) return `${s}T00:00:00.000Z`;
  const spaced = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(?::(\d{2}))?$/.exec(s);
  const candidate = spaced ? `${spaced[1]}T${spaced[2]}:${spaced[3] ?? "00"}` : s;
  const t = Date.parse(candidate);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/** The `date` value Cairn writes: the day only when the time is midnight UTC, else the full ISO time. */
export function formatMeetingDate(iso: string): string {
  return iso.endsWith("T00:00:00.000Z") ? iso.slice(0, 10) : iso;
}

/** Placeholders and groups that sit where a name would ("Attendees: TBD", "Participants: users"). */
const NOT_NAMES = new Set([
  "tbd", "tba", "tbc", "none", "n/a", "na", "nobody", "everyone", "everybody", "all", "team", "the team", "whole team",
  "users", "user", "admins", "admin", "staff", "others", "other", "attendees", "participants", "guests", "?", "-", "–",
]);

/** True for a placeholder or group where a name would be ("TBD", "team", "users"): never a person. */
export function isGroupName(name: string): boolean {
  return NOT_NAMES.has(foldName(name));
}

/** The body without fenced code blocks and inline code, where `[[x]]` and "Attendees:" are text, not metadata. */
export function withoutCode(body: string): string {
  let fence: { ch: string; len: number } | null = null;
  const kept: string[] = [];
  for (const line of body.split(/\r?\n/)) {
    const m = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
    if (m) {
      // A fence closes only on the same character, at least as long, with nothing after it.
      if (!fence) fence = { ch: m[1][0], len: m[1].length };
      else if (m[1][0] === fence.ch && m[1].length >= fence.len && m[2].trim() === "") fence = null;
      continue;
    }
    if (!fence) kept.push(line.replace(/`[^`\n]*`/g, ""));
  }
  return kept.join("\n");
}

/** Attendees and date found in a note body's metadata lines. */
export interface BodyMeetingLines {
  attendees: AttendeeRef[];
  date: string | null;
}

/**
 * Read `**Attendees:** A, B` and `**When:** 2026-11-11` style lines from the
 * first part of a note body (bold or plain label, optional list bullet; also
 * "Participants" and "Date"). Used by migration and import to suggest attendees,
 * never applied silently. Returns null when the body has no attendee line.
 */
export function parseBodyMeetingLines(markdown: string): BodyMeetingLines | null {
  const head = markdown.split(/\r?\n/).slice(0, 40);
  let attendees: AttendeeRef[] | null = null;
  let date: string | null = null;
  for (const line of head) {
    // The label needs a colon ("**Attendees:**", "**Attendees**:", "Attendees:"), so prose like "When we met" never matches.
    const m = /^\s*([-*]\s+)?(\*\*|__)?(attendees|participants|when|date)(?:\s*:\s*(?:\*\*|__)|(?:\*\*|__)\s*:|\s*:)\s*(.+)$/i.exec(line);
    // A bold label or a list bullet is required: a bare "Participants: users, admins" is prose.
    if (!m || (!m[1] && !m[2])) continue;
    const label = m[3].toLowerCase();
    const value = m[4].trim();
    if ((label === "attendees" || label === "participants") && attendees === null) {
      attendees = parseAttendeeList(value).filter((a) => !a.name || a.email || !NOT_NAMES.has(foldName(a.name)));
    } else if ((label === "when" || label === "date") && date === null) {
      date = parseMeetingDate(value.replace(/[,(].*$/, "").trim()) ?? parseLooseDate(value);
    }
  }
  return attendees && attendees.length ? { attendees, date } : null;
}

/** First YYYY-MM-DD anywhere in the text (e.g. "Tue 2026-11-11, 15:00 CET"). */
function parseLooseDate(s: string): string | null {
  const m = /(\d{4}-\d{2}-\d{2})/.exec(s);
  return m ? parseMeetingDate(m[1]) : null;
}

/** One checklist line with an owner. */
export interface ChecklistItem {
  /** 0-based line index in the body. */
  line: number;
  /** The full line as written (used for a stable key and for ticking it). */
  raw: string;
  done: boolean;
  /** Owner as written ("Chris", "Team"); null when the line names no owner. */
  owner: AttendeeRef | null;
  /** The task text without the owner prefix. */
  text: string;
}

/**
 * Checklist lines in a note body, with their owner when the line starts with one:
 *   "- [ ] **Chris** - validate the hospital PR"
 *   "- [ ] [[Chris Sponagle]]: viewpoint APIs"
 *   "- [x] @Chris to send the deck"
 * Lines without an owner are returned with `owner: null`.
 */
export function parseChecklist(markdown: string): ChecklistItem[] {
  const out: ChecklistItem[] = [];
  const lines = markdown.split(/\r?\n/);
  let fence = false;
  lines.forEach((raw, line) => {
    if (/^\s*(```|~~~)/.test(raw)) { fence = !fence; return; }
    if (fence) return;
    const m = /^\s*[-*+]\s+\[([ xX])\]\s+(.*)$/.exec(raw);
    if (!m) return;
    const done = m[1] !== " ";
    const rest = m[2].trim();
    const owned =
      /^\*\*([^*]+)\*\*(?:\s*[-–—:]\s*|\s+to\s+|\s+|$)(.*)$/.exec(rest) ??
      /^(\[\[[^\]]+\]\])(?:\s*[-–—:]\s*|\s+to\s+|\s+|$)(.*)$/.exec(rest) ??
      /^@([\p{L}\p{N}_.-]+)(?:\s*[-–—:]\s*|\s+to\s+|\s+|$)(.*)$/u.exec(rest);
    if (owned) {
      const owner = parseAttendeeValue(owned[1]);
      out.push({ line, raw, done, owner, text: owned[2].trim() || rest });
    } else {
      out.push({ line, raw, done, owner: null, text: rest });
    }
  });
  return out;
}
