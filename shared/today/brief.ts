/**
 * Today brief: the structured result of the built-in "Today" automation.
 *
 * The automation's agent run ends with one JSON object (see the recipe in
 * `electron/lib/today.ts`); `parseTodayBrief` pulls it out of the final message
 * and normalises it so the renderer never has to guard against a model that
 * dropped a field. Pure, no Node or Electron APIs.
 */

export const TODAY_BRIEF_VERSION = 2;

/** Marks the automation row that powers a project's Today tab. */
export const TODAY_COMMUNITY_ID = "cairn:today";

export type TodayTone = "good" | "warn" | "neutral";

export interface TodayEvent {
  title: string;
  /** "HH:MM" local time. */
  start: string;
  end?: string;
  location?: string;
  url?: string;
  /** Free text, e.g. "moved by organiser", "no agenda". */
  note?: string;
}

/** One answer to a decision. `draftId` points at the `prepared` reply that carries it out. */
export interface TodayChoice {
  label: string;
  draftId?: string;
}

export interface TodayNeedItem {
  id: string;
  /** "decision": a question with choices. "todo": something to do, no choice to make. */
  kind: "decision" | "todo";
  /** The question (decisions) or the action (to-dos). */
  title: string;
  /** Short context, about 30 words. */
  body?: string;
  /** Why this ranks where it does. Shown behind "Show more". */
  why?: string;
  /** Up to three short fact chips ("Asked 12:56", "Liron on thread"). */
  facts: string[];
  /** Two or three answers to a decision; empty for to-dos. */
  choices: TodayChoice[];
  /** Connector or Cairn area the item came from ("GitHub", "Slack", "Board"). */
  source: string;
  url?: string;
  /** Relative age, e.g. "3d", "12h". */
  age?: string;
  /** Id of a `prepared` draft that answers this item. */
  draftId?: string;
}

export interface TodayPrepared {
  id: string;
  title: string;
  kind: "reply" | "review" | "cards" | "note" | "other";
  /** Where the draft would go: "Jira CAIRN-212", "#release in Slack". */
  target?: string;
  /** The drafted text itself. Never sent by the automation. */
  draft: string;
  source: string;
  url?: string;
}

export interface TodayFyi {
  title: string;
  detail?: string;
  tone: TodayTone;
  source: string;
  url?: string;
}

export interface TodaySourceStatus {
  name: string;
  status: "ok" | "empty" | "error" | "skipped";
  items?: number;
  note?: string;
}

export interface TodayBrief {
  version: number;
  /** ISO time the run finished. */
  generatedAt: string;
  /** Local date the brief is for, "YYYY-MM-DD". */
  date: string;
  /** One line naming the first decision ("Decide on Edan's P4 interview first."). */
  headline: string;
  /** At most ~25 words of context under the headline. No counts: the tiles carry them. */
  lede: string;
  /** Id of the `needYou` item to start with. */
  focusId?: string;
  events: TodayEvent[];
  needYou: TodayNeedItem[];
  prepared: TodayPrepared[];
  fyi: TodayFyi[];
  sources: TodaySourceStatus[];
  /** Optional hint about a missing source that would have helped. */
  gap?: string;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const arr = (v: unknown): Record<string, unknown>[] =>
  Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === "object") : [];
const HHMM = /^\d{1,2}:\d{2}$/;
const PREPARED_KINDS = new Set(["reply", "review", "cards", "note", "other"]);
const SOURCE_STATUS = new Set(["ok", "empty", "error", "skipped"]);
const TONES = new Set(["good", "warn", "neutral"]);

/** The last fenced ```json block, else the outermost `{…}` span. */
export function extractJsonObject(text: string): string | null {
  const fences = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)];
  for (let i = fences.length - 1; i >= 0; i--) {
    const body = fences[i][1].trim();
    if (body.startsWith("{")) return body;
  }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  return start >= 0 && end > start ? text.slice(start, end + 1) : null;
}

/**
 * Parse and normalise the automation's final message. Returns null when no
 * usable JSON object is present. Items missing their required text are
 * dropped; ids are filled in when the model left them out.
 */
export function parseTodayBrief(text: string, now: Date = new Date()): TodayBrief | null {
  const raw = extractJsonObject(text);
  if (!raw) return null;
  let o: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    o = parsed as Record<string, unknown>;
  } catch {
    return null;
  }

  const needYou: TodayNeedItem[] = arr(o.needYou).flatMap((x, i) => {
    const title = str(x.question) ?? str(x.title);
    if (!title) return [];
    const choices: TodayChoice[] = arr(x.choices).flatMap((c) => {
      const label = str(c.label);
      return label ? [{ label, draftId: str(c.draftId) }] : [];
    }).slice(0, 3);
    const facts = (Array.isArray(x.facts) ? x.facts : []).map(str).filter((f): f is string => !!f).slice(0, 3);
    const kind = str(x.kind) === "todo" || choices.length === 0 ? "todo" : "decision";
    return [{
      id: str(x.id) ?? `need-${i + 1}`, kind, title, body: str(x.body), why: str(x.why), facts, choices,
      source: str(x.source) ?? "Cairn", url: str(x.url), age: str(x.age), draftId: str(x.draftId),
    }];
  });
  const prepared: TodayPrepared[] = arr(o.prepared).flatMap((x, i) => {
    const title = str(x.title);
    const draft = str(x.draft);
    if (!title || !draft) return [];
    const kind = str(x.kind);
    return [{
      id: str(x.id) ?? `draft-${i + 1}`, title, draft,
      kind: (kind && PREPARED_KINDS.has(kind) ? kind : "other") as TodayPrepared["kind"],
      target: str(x.target), source: str(x.source) ?? "Cairn", url: str(x.url),
    }];
  });
  const fyi: TodayFyi[] = arr(o.fyi).flatMap((x) => {
    const title = str(x.title);
    if (!title) return [];
    const tone = str(x.tone);
    return [{
      title, detail: str(x.detail), source: str(x.source) ?? "Cairn", url: str(x.url),
      tone: (tone && TONES.has(tone) ? tone : "neutral") as TodayTone,
    }];
  });
  const events: TodayEvent[] = arr(o.events).flatMap((x) => {
    const title = str(x.title);
    const start = str(x.start);
    if (!title || !start || !HHMM.test(start)) return [];
    const end = str(x.end);
    return [{ title, start, end: end && HHMM.test(end) ? end : undefined, location: str(x.location), url: str(x.url), note: str(x.note) }];
  }).sort((a, b) => toMinutes(a.start) - toMinutes(b.start));
  const sources: TodaySourceStatus[] = arr(o.sources).flatMap((x) => {
    const name = str(x.name);
    if (!name) return [];
    const status = str(x.status);
    return [{
      name, note: str(x.note),
      status: (status && SOURCE_STATUS.has(status) ? status : "ok") as TodaySourceStatus["status"],
      items: typeof x.items === "number" && Number.isFinite(x.items) ? x.items : undefined,
    }];
  });

  const draftIds = new Set(prepared.map((p) => p.id));
  for (const n of needYou) {
    if (n.draftId && !draftIds.has(n.draftId)) n.draftId = undefined;
    for (const c of n.choices) if (c.draftId && !draftIds.has(c.draftId)) c.draftId = undefined;
  }
  const focus = str(o.focusId);
  const focusItem = needYou.find((n) => n.id === focus) ?? needYou[0];

  return {
    version: TODAY_BRIEF_VERSION,
    generatedAt: now.toISOString(),
    date: localDate(now),
    headline: str(o.headline) ?? (focusItem ? `Start with: ${focusItem.title}` : "Nothing needs you right now."),
    lede: firstSentences(str(o.lede) ?? summaryLede(needYou.length, prepared.length), 2, 40),
    focusId: focusItem?.id,
    events, needYou, prepared, fyi, sources,
    gap: str(o.gap),
  };
}

/** Keep at most `n` sentences and `maxWords` words; a model that rambles still fits the header. */
export function firstSentences(text: string, n: number, maxWords: number): string {
  // A sentence ends at . ! or ? followed by a space, so "firefly.js" or "v3.2" stays whole.
  const sentences = text.trim().split(/(?<=[.!?])\s+/);
  let out = sentences.slice(0, n).join(" ").trim();
  const words = out.split(/\s+/);
  if (words.length > maxWords) out = `${words.slice(0, maxWords).join(" ").replace(/[,;:\-–—]+$/, "")}…`;
  return out;
}

/** Ids of drafts that a need item (or one of its choices) carries out. */
export function linkedDraftIds(brief: Pick<TodayBrief, "needYou">): Set<string> {
  const ids = new Set<string>();
  for (const n of brief.needYou) {
    if (n.draftId) ids.add(n.draftId);
    for (const c of n.choices) if (c.draftId) ids.add(c.draftId);
  }
  return ids;
}

function summaryLede(need: number, prepared: number): string {
  if (need === 0 && prepared === 0) return "Nothing needs you right now.";
  return `${need} ${need === 1 ? "thing needs" : "things need"} you and ${prepared} ${prepared === 1 ? "draft is" : "drafts are"} ready.`;
}

/** "HH:MM" → minutes since midnight. */
export function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map((n) => parseInt(n, 10));
  return (h || 0) * 60 + (m || 0);
}

/** Local "YYYY-MM-DD". */
export function localDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export interface TodayDayBlock {
  kind: "free" | "meeting";
  /** Minutes since midnight. */
  start: number;
  end: number;
  /** Ended before `now`. */
  past: boolean;
  /** The longest free stretch still ahead: where the focus item fits. */
  best?: boolean;
  event?: TodayEvent;
}

export interface TodayDay {
  blocks: TodayDayBlock[];
  /** Free minutes still ahead today. */
  freeLeft: number;
  freeBlocksLeft: number;
  /** The longest free stretch still ahead, in minutes. */
  largestFree: number;
  meetingsLeft: number;
  nextMeeting?: TodayEvent;
}

/**
 * The working day as alternating meeting and free blocks. A free block that
 * straddles `now` is split, so time already gone never reads as available.
 * Overlapping meetings merge into one busy span for the free-time maths but
 * each keeps its own block. Free gaps shorter than `minFree` are dropped.
 */
export function dayBlocks(
  events: TodayEvent[], now: number, { dayStart = 8 * 60, dayEnd = 18 * 60, minFree = 20 } = {},
): TodayDay {
  const meetings = events
    .map((e) => ({ e, s: toMinutes(e.start), en: e.end ? toMinutes(e.end) : toMinutes(e.start) + 30 }))
    .filter((m) => m.en > m.s)
    .sort((a, b) => a.s - b.s);
  const free: Array<{ s: number; e: number }> = [];
  let cursor = dayStart;
  for (const m of meetings) {
    if (m.s - cursor >= minFree) free.push({ s: cursor, e: Math.min(m.s, dayEnd) });
    cursor = Math.max(cursor, m.en);
  }
  if (dayEnd - cursor >= minFree) free.push({ s: cursor, e: dayEnd });

  const blocks: TodayDayBlock[] = [];
  for (const f of free) {
    if (f.s < now && f.e > now) {
      blocks.push({ kind: "free", start: f.s, end: now, past: true });
      if (f.e - now >= minFree) blocks.push({ kind: "free", start: now, end: f.e, past: false });
    } else {
      blocks.push({ kind: "free", start: f.s, end: f.e, past: f.e <= now });
    }
  }
  for (const m of meetings) blocks.push({ kind: "meeting", start: m.s, end: m.en, past: m.en <= now, event: m.e });
  blocks.sort((a, b) => a.start - b.start || (a.kind === "meeting" ? 1 : -1));

  const ahead = blocks.filter((b) => b.kind === "free" && !b.past);
  const best = ahead.reduce<TodayDayBlock | null>((a, b) => (!a || b.end - b.start > a.end - a.start ? b : a), null);
  if (best) best.best = true;
  const upcoming = meetings.filter((m) => m.en > now);
  return {
    blocks,
    freeLeft: ahead.reduce((sum, b) => sum + (b.end - b.start), 0),
    freeBlocksLeft: ahead.length,
    largestFree: best ? best.end - best.start : 0,
    meetingsLeft: upcoming.length,
    nextMeeting: upcoming[0]?.e,
  };
}

/** "3h 4m", "45m", "2h". */
export function formatMinutes(m: number): string {
  const h = Math.floor(m / 60);
  const r = Math.round(m % 60);
  if (h === 0) return `${r}m`;
  return r ? `${h}h ${r}m` : `${h}h`;
}

/** Minutes since midnight → "HH:MM". */
export function formatClock(m: number): string {
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(Math.round(m % 60)).padStart(2, "0")}`;
}

/** Today state returned to the renderer by `today:get`. */
export interface TodayState {
  /** The project's Today automation, or null when Today is off and was never set up. */
  automationId: string | null;
  enabled: boolean;
  /** "HH:MM" refresh time. */
  time: string;
  weekdaysOnly: boolean;
  nextRunAt: string | null;
  running: boolean;
  /** Latest saved brief (today or the most recent day). */
  brief: TodayBrief | null;
  /** Error of the latest run when it failed or produced no brief. */
  lastError: string | null;
}

/** Cron expression for a refresh time ("HH:MM"). */
export function todayCron(time: string, weekdaysOnly: boolean): string {
  const [h, m] = time.split(":").map((n) => parseInt(n, 10));
  return `cron ${m || 0} ${h || 0} * * ${weekdaysOnly ? "1-5" : "*"}`;
}

/** Inverse of `todayCron`; falls back to 07:00 weekdays. */
export function parseTodayCron(expr: string): { time: string; weekdaysOnly: boolean } {
  const m = expr.match(/^cron\s+(\d+)\s+(\d+)\s+\*\s+\*\s+(\S+)$/);
  if (!m) return { time: "07:00", weekdaysOnly: true };
  const p = (n: string) => n.padStart(2, "0");
  return { time: `${p(m[2])}:${p(m[1])}`, weekdaysOnly: m[3] === "1-5" };
}
