/**
 * Migration heuristics (W9): which existing notes look like a person's persona
 * note, and which look like meeting notes. Pure (no Node, no DB), so desktop,
 * the MCP runtime and mobile read notes the same way. The inventory
 * (`electron/db/people-migration.ts`) feeds these notes it loaded; nothing
 * here writes or reaches outside its arguments. Plan: docs/plans/people-layer.md
 * ("Migrating existing person notes").
 *
 * Every guess carries its reasons, so the user can see why a note was picked
 * and overrule it. A guess is never applied by itself.
 */

import {
  foldName, isEmail, parseAttendeeList, parseBodyMeetingLines, parseMeetingDate, withoutCode, type AttendeeRef,
} from "./parse";

/** Keys a note file's frontmatter may carry that matter here (read from disk by the caller; Cairn doesn't store them). */
export interface NoteFrontmatterHints {
  type?: string;
  tags: string[];
  aliases: string[];
  emails: string[];
  hasAttendees: boolean;
  attendees: unknown;
  date: unknown;
}

/** One note as the heuristics see it. */
export interface InventoryNote {
  id: string;
  title: string;
  folder: string;
  content: string;
  tagNames: string[];
  frontmatter?: NoteFrontmatterHints | null;
}

export type Confidence = "high" | "medium" | "low";

export interface PersonaGuess {
  /** The person's name as the note's title gives it (prefix and nicknames removed). */
  name: string;
  /** Nicknames and other names the note states about itself (title parentheses, `aliases`). Never the persona title. */
  aliases: string[];
  emails: string[];
  confidence: Confidence;
  score: number;
  reasons: string[];
}

const STRONG_TAGS = new Set(["person", "people", "persona", "personas", "contact", "colleague", "teammate"]);
const STRONG_TYPES = new Set(["person", "people", "persona", "contact", "colleague"]);
const PEOPLE_FOLDERS = new Set(["people", "person", "persons", "persona", "personas", "contacts", "colleagues", "directory"]);
/** Words that make a capitalised title a topic, not a name ("Weekly Sync"). */
const NOT_NAME_WORDS = new Set([
  "weekly", "daily", "monthly", "sync", "meeting", "meetings", "notes", "note", "standup", "retro", "retrospective", "review", "planning",
  "roadmap", "project", "team", "agenda", "summary", "discussion", "discussions", "template", "overview", "plan", "ideas", "idea",
  "todo", "tasks", "task", "journal", "index", "home", "welcome", "onboarding", "hiring", "interview", "kickoff", "update", "updates",
  "report", "strategy", "goals", "goal", "okr", "okrs", "backlog", "sprint", "demo", "workshop", "offsite", "q1", "q2", "q3", "q4",
]);
const PARTICLES = new Set(["de", "del", "della", "van", "von", "der", "den", "la", "le", "di", "da", "bin", "al", "el", "st", "ter", "ten", "dos", "das"]);

const norm = (s: string) => foldName(s.replace(/^#/, ""));

/** "Chris Sponagle", "Ana de la Cruz", "Marie-Claire O'Neil": 2–4 words that read as a person's name. */
export function looksLikeName(title: string): boolean {
  const tokens = title.trim().split(/\s+/);
  if (tokens.length < 2 || tokens.length > 4) return false;
  let capitalised = 0;
  for (const t of tokens) {
    if (/\d/.test(t)) return false;
    const folded = foldName(t);
    if (NOT_NAME_WORDS.has(folded)) return false;
    if (/^\p{Lu}[\p{L}'’.-]*$/u.test(t)) capitalised++;
    else if (!PARTICLES.has(folded)) return false;
  }
  return capitalised >= 2;
}

/** A first name or nickname: one capitalised word, not a topic word. */
function looksLikeShortName(s: string): boolean {
  return /^\p{Lu}[\p{L}'’-]{1,19}$/u.test(s) && !NOT_NAME_WORDS.has(foldName(s));
}

const TITLE_PREFIX = /^\s*(?:persona|person|profile|people|contact)\s*[-:–—]\s*/i;

/** The name, and the nicknames, a note title gives: `Persona - Sebastien "Seb" Morel (SM)` → Sebastien Morel + Seb, SM. */
export function nameFromTitle(title: string): { name: string; aliases: string[] } {
  let s = title.replace(TITLE_PREFIX, "").trim();
  const aliases: string[] = [];
  s = s.replace(/["“”]([^"“”]{1,20})["“”]/g, (_m, nick: string) => {
    if (looksLikeShortName(nick.trim()) || /^[\p{Lu}]{2,4}$/u.test(nick.trim())) aliases.push(nick.trim());
    return " ";
  });
  s = s.replace(/\(([^)]{1,20})\)/g, (_m, inner: string) => {
    const v = inner.trim();
    // "(Seb)" or "(CJ)" is a nickname; "(Engineering Manager)" is a role and is dropped.
    if (/^\p{Lu}[\p{L}'’-]*$/u.test(v) && !NOT_NAME_WORDS.has(foldName(v))) aliases.push(v);
    return " ";
  });
  return { name: s.replace(/\s+/g, " ").trim(), aliases };
}

const EMAIL_IN_TEXT = /[^\s@<>()[\]"',;]+@[^\s@<>()[\]"',;]+\.[^\s@<>()[\]"',;]+/g;

/** Emails a persona note states about the person: frontmatter `email(s)`, and `Email:` lines near the top. */
function emailsFrom(note: InventoryNote): string[] {
  const out = new Set<string>();
  for (const e of note.frontmatter?.emails ?? []) if (isEmail(e)) out.add(e.trim().toLowerCase());
  for (const line of note.content.split(/\r?\n/).slice(0, 40)) {
    const m = /^\s*(?:[-*]\s+)?(?:\*\*|__)?e-?mails?(?:\s*:\s*(?:\*\*|__)|(?:\*\*|__)\s*:|\s*:)\s*(.+)$/i.exec(line);
    if (!m) continue;
    for (const e of m[1].match(EMAIL_IN_TEXT) ?? []) if (isEmail(e)) out.add(e.toLowerCase());
  }
  return [...out];
}

/** Does this note look like the persona note of one person? Null when nothing says so. */
export function guessPersona(note: InventoryNote): PersonaGuess | null {
  const fm = note.frontmatter ?? null;
  const reasons: string[] = [];
  let score = 0;

  const tags = [...note.tagNames, ...(fm?.tags ?? [])].map(norm);
  const strongTag = tags.find((t) => STRONG_TAGS.has(t));
  if (strongTag) { score += 3; reasons.push(`tagged ${strongTag}`); }
  else if (fm?.type && STRONG_TYPES.has(norm(fm.type))) { score += 3; reasons.push(`frontmatter type: ${fm.type}`); }

  const { name, aliases: titleAliases } = nameFromTitle(note.title);
  if (!name) return null;
  const prefixed = TITLE_PREFIX.test(note.title);
  if (prefixed) { score += 2; reasons.push("title starts with “Persona/Person/Profile”"); }

  const rawSegments = note.folder.split("/").map((s) => s.trim()).filter(Boolean);
  const segments = rawSegments.map(norm);
  const peopleFolder = rawSegments.find((s) => PEOPLE_FOLDERS.has(norm(s)));
  if (peopleFolder) { score += 2; reasons.push(`in a “${peopleFolder}” folder`); }
  // `Discussions/Chris Sponagle` holding a note titled for them.
  const nameLike = looksLikeName(name);
  if (nameLike && segments.includes(foldName(name))) { score += 2; reasons.push("folder is named for them"); }

  if (nameLike && score > 0) { score += 1; reasons.push("title reads as a name"); }
  else if (!nameLike && score > 0) reasons.push("title doesn't read as a name");

  if (score < 2) return null;
  const confidence: Confidence = score >= 4 ? "high" : score >= 3 ? "medium" : "low";
  const aliases = [...new Set([...titleAliases, ...(fm?.aliases ?? []).map((a) => String(a).trim()).filter(Boolean)])]
    .filter((a) => foldName(a) !== foldName(name));
  return { name, aliases, emails: emailsFrom(note), confidence, score, reasons };
}

/** What a note says about a meeting it records. */
export interface MeetingGuess {
  attendees: AttendeeRef[];
  /** ISO date: the frontmatter `date` (with attendees) or the body "When:" line. */
  date: string | null;
  /** Where the attendees came from; both when the note has an `attendees` property and a body line. */
  via: Array<"frontmatter" | "body_line">;
  frontmatterAttendees: AttendeeRef[];
  bodyAttendees: AttendeeRef[];
}

/**
 * Attendees from a note's `attendees` frontmatter and its `**Attendees:**` body
 * line (the conventions capture reads; code blocks are ignored). Null when the
 * note lists none. A frontmatter `date` counts only next to `attendees`, so
 * journal notes with a date are not meetings.
 */
export function guessMeeting(note: Pick<InventoryNote, "content" | "frontmatter">): MeetingGuess | null {
  const fm = note.frontmatter ?? null;
  const frontmatterAttendees = fm?.hasAttendees
    ? parseAttendeeList(Array.isArray(fm.attendees) ? fm.attendees.filter((v) => typeof v === "string") : fm.attendees)
    : [];
  const body = parseBodyMeetingLines(withoutCode(note.content));
  const bodyAttendees = body?.attendees ?? [];
  if (frontmatterAttendees.length === 0 && bodyAttendees.length === 0) return null;
  const via: MeetingGuess["via"] = [];
  if (frontmatterAttendees.length) via.push("frontmatter");
  if (bodyAttendees.length) via.push("body_line");
  const date = frontmatterAttendees.length
    ? parseMeetingDate(fm?.date) ?? body?.date ?? null
    : body?.date ?? null;
  return { attendees: frontmatterAttendees.length ? frontmatterAttendees : bodyAttendees, date, via, frontmatterAttendees, bodyAttendees };
}

/** The first word of a multi-word name, for a "short name" alias suggestion ("Chris" for "Chris Sponagle"). */
export function firstName(name: string): string | null {
  const tokens = name.trim().split(/\s+/);
  return tokens.length >= 2 && looksLikeShortName(tokens[0]) ? tokens[0] : null;
}
