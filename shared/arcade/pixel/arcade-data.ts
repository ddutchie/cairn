/**
 * Arcade workspace data types, due-date bucketing, label interleaving, and
 * demo fallback workspace shared by desktop and mobile.
 */

import type { Priority } from "../../types/domain";
import { parseWikilinks } from "../../notes/wikilinks";
import { fontSafe } from "./font";
import type { Label } from "./kinds";
import { BIOME_ORDER, hash2, type BiomeName } from "./terrain";

export type DueScope = "overdue" | "today" | "untimed" | "later";

export interface ArcadeTask {
  title: string;
  priority: Priority;
  /** Minutes after 09:00 today it is due; negative = already overdue. */
  dueMin: number;
  overdue: boolean;
  dueScope?: DueScope;
}

export interface ArcadeNote {
  id: string;
  title: string;
  words: number;
  links: string[];
}

export interface ArcadeProject {
  id: string;
  name: string;
  accent: string;
  biome: BiomeName;
  tasks: ArcadeTask[];
  notes: ArcadeNote[];
}

export interface ArcadeData {
  projects: ArcadeProject[];
  tags: string[];
  labels: Label[];
  demo: boolean;
}

export const ACCENTS = ["#2ec4b6", "#e3a23b", "#5b8dd6", "#d9483b", "#7cc46a", "#c45aa8"];
const MAX_TITLE = 28;

export const cleanArcadeTitle = (s: string): string => fontSafe(s).slice(0, MAX_TITLE) || "UNTITLED";

/** A note as the loaders read it, before it becomes an `ArcadeNote`. */
export interface ArcadeNoteSource {
  id: string;
  title: string;
  /** Markdown body, or whatever excerpt is loaded (wikilinks in it count). */
  body: string | null | undefined;
  /** Stored note links (`linked_note_ids`). */
  linkedIds: readonly string[];
}

/**
 * Each note's links among the notes in play: its stored links plus the
 * `[[Title]]` wikilinks in its body, matched by title (case-insensitive).
 * Notes often link only by wikilink, so without these most islands would be
 * unlinked and every landing the same "lost island".
 */
export function arcadeNoteLinks(notes: readonly ArcadeNoteSource[]): Map<string, string[]> {
  const ids = new Set(notes.map((n) => n.id));
  const byTitle = new Map<string, string>();
  for (const n of notes) {
    const k = n.title.trim().toLowerCase();
    if (k && !byTitle.has(k)) byTitle.set(k, n.id);
  }
  const out = new Map<string, string[]>();
  for (const n of notes) {
    const links = new Set(n.linkedIds.filter((id) => ids.has(id)));
    if (n.body) {
      for (const w of parseWikilinks(n.body)) {
        // `[[Title|alias]]` and `[[Title#heading]]` point at Title.
        const id = byTitle.get(w.title.split(/[|#]/)[0].trim().toLowerCase());
        if (id) links.add(id);
      }
    }
    links.delete(n.id);
    out.set(n.id, [...links]);
  }
  return out;
}

/** Minutes between 09:00 on `now`'s day and the due timestamp, plus Today scope. */
export function dueMinutes(due: string | null | undefined, now: Date, seed: number): { dueMin: number; overdue: boolean; dueScope: DueScope } {
  const start = new Date(now);
  start.setHours(9, 0, 0, 0);
  if (!due) return { dueMin: 120 + Math.round(hash2(seed, 3, 9) * 400), overdue: false, dueScope: "untimed" };
  const d = new Date(due.length <= 10 ? `${due}T17:00:00` : due);
  if (Number.isNaN(d.getTime())) return { dueMin: 300, overdue: false, dueScope: "untimed" };
  const endOfDay = new Date(now);
  endOfDay.setHours(23, 59, 59, 999);
  const mins = Math.round((d.getTime() - start.getTime()) / 60_000);
  if (d < start) return { dueMin: Math.max(-540, Math.min(-30, mins)), overdue: true, dueScope: "overdue" };
  if (d > endOfDay) return { dueMin: 520, overdue: false, dueScope: "later" };
  return { dueMin: Math.min(520, Math.max(45, mins)), overdue: false, dueScope: "today" };
}

/** Project, note, task, tag, round-robin, capped at 64 labels. */
export function interleave(d: Pick<ArcadeData, "projects" | "tags">): Label[] {
  const lists: Label[][] = [
    d.projects.map((p) => ({ label: p.name, kind: "project" as const })),
    d.projects.flatMap((p) => p.notes.map((n) => ({ label: n.title, kind: "note" as const }))),
    d.projects.flatMap((p) => p.tasks.map((t) => ({ label: t.title, kind: "card" as const }))),
    d.tags.map((t) => ({ label: t, kind: "tag" as const })),
  ];
  const out: Label[] = [];
  for (let i = 0; out.length < 64 && lists.some((l) => i < l.length); i++) {
    for (const l of lists) {
      if (out.length >= 64) break;
      if (i < l.length) out.push(l[i]);
    }
  }
  return out;
}

type DemoTask = [string, Priority, number];
type DemoNote = [string, number, number[]];
const DEMO: [string, DemoTask[], DemoNote[]][] = [
  ["CAIRN MOBILE",
    [["FIX SYNC CONFLICT", "urgent", 60], ["CRASH ON LARGE NOTES", "high", 200], ["OFFLINE QUEUE RETRY", "high", 260], ["PUSH OPT-IN FLOW", "medium", 300], ["SEARCH HIGHLIGHT", "medium", 340], ["DARK MODE CONTRAST", "low", 480], ["WIDGET EMPTY STATE", "low", 420], ["SHIP RELEASE NOTES", "high", -120]],
    [["SYNC DESIGN", 1800, [1, 2, 3]], ["OFFLINE QUEUE", 900, [2]], ["RELEASE CHECKLIST", 600, [4]], ["WIDGET IDEAS", 300, []], ["QA SCRIPT", 700, [2]], ["PUSH OPT-IN", 250, [1]]]],
  ["WEBSITE RELAUNCH",
    [["APPROVE HOMEPAGE COPY", "high", 180], ["BOOK PHOTOGRAPHER", "low", 420], ["PRICING TABLE", "medium", 280], ["MIGRATE CMS", "high", 220], ["LAUNCH DAY PLAN", "urgent", 150], ["COOKIE BANNER", "low", 460], ["FIX FOOTER LINKS", "medium", -300]],
    [["BRAND VOICE", 1200, [7, 8]], ["SITEMAP", 500, [8]], ["LAUNCH NOTES", 800, [6]], ["MOODBOARD", 200, []], ["SEO AUDIT", 400, [7]], ["OLD PITCH DECK", 260, []]]],
  ["Q1 PLANNING",
    [["DRAFT OKRS", "high", 120], ["HEADCOUNT SHEET", "medium", 360], ["HIRING PLAN", "high", 240], ["BOOK OFFSITE", "low", 400], ["BOARD UPDATE", "urgent", 100], ["TEAM SURVEY", "low", 470]],
    [["HEADCOUNT", 700, [13]], ["ROADMAP Q1", 1600, [12, 14, 0]], ["OKRS", 900, [13]], ["LAST YEAR REVIEW", 1100, []], ["READING LIST", 350, []]]],
  ["KITCHEN RENO",
    [["ORDER TILES", "medium", 240], ["CALL PLUMBER", "urgent", 90], ["PERMIT FORMS", "high", 200], ["PICK PAINT", "low", 450], ["PAY CONTRACTOR", "high", -60], ["BUDGET REVIEW", "medium", -500]],
    [["FLOOR PLAN", 650, [18]], ["CONTRACTOR QUOTES", 400, [17, 19]], ["TILE SAMPLES", 150, []], ["BUDGET", 500, [18]]]],
  ["GARDEN",
    [["SOW TOMATOES", "low", 400], ["TURN COMPOST", "low", 430], ["FIX HOSE", "medium", 310], ["ORDER SEEDS", "low", 380], ["MULCH BEDS", "medium", 330]],
    [["PLANTING PLAN", 800, [22]], ["SEED LIST", 300, [21]], ["COMPOST", 120, []], ["DREAM JOURNAL", 900, []]]],
];

export const DEMO_ARCADE_PROJECTS: ArcadeProject[] = (() => {
  let n = 0;
  return DEMO.map(([name, tasks, notes], i) => ({
    id: `demo-${i}`,
    name,
    accent: ACCENTS[i % ACCENTS.length],
    biome: BIOME_ORDER[i % BIOME_ORDER.length],
    tasks: tasks.map(([title, priority, dueMin]) => ({
      title,
      priority,
      dueMin,
      overdue: dueMin < 0,
      dueScope: (dueMin < 0 ? "overdue" : "today") as DueScope,
    })),
    notes: notes.map(([title, words, links]) => ({ id: `n${n++}`, title, words, links: links.map((j) => `n${j}`) })),
  }));
})();

export const DEMO_DATA: ArcadeData = (() => {
  const tags = ["MOBILE", "DESIGN", "URGENT", "HOME", "RESEARCH", "LATER", "Q1", "BLOCKED", "BUG", "COPY"];
  const data: ArcadeData = { projects: DEMO_ARCADE_PROJECTS, tags, labels: [], demo: true };
  data.labels = interleave(data);
  return data;
})();
