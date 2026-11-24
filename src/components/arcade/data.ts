/**
 * What the arcade games read from the workspace: projects with their open
 * tasks and notes, note-to-note links, and tag names. Built once when a game
 * starts (the games never write anything back). A thin workspace falls back to
 * a demo one, so every game is playable on a fresh install.
 */

import type { BoardColumn, TaskCard } from "@cairn/shared/types/board";
import type { ColumnType, Priority } from "@cairn/shared/types/domain";
import type { Note } from "@cairn/shared/types/notes";
import type { Project, Tag } from "@cairn/shared/types/workspace";
import { BIOME_ORDER, fontSafe, hash2, type BiomeName } from "./pixel/kit";

export type EntityKind = "project" | "note" | "card" | "tag";

export interface Label {
  label: string;
  kind: EntityKind;
}

export type DueScope = "overdue" | "today" | "untimed" | "later";

export interface ArcadeTask {
  title: string;
  priority: Priority;
  /** Minutes after 09:00 today it's due; negative = already overdue. */
  dueMin: number;
  overdue: boolean;
  dueScope?: DueScope;
  column: ColumnType;
}

export interface ArcadeNote {
  id: string;
  title: string;
  /** Rough length, drives island size. */
  words: number;
  /** Note ids this note links to (same arcade data only). */
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
  /** Interleaved project / note / task / tag names, for bricks and stones. */
  labels: Label[];
  /** True when this is the built-in demo workspace. */
  demo: boolean;
}

export const ACCENTS = ["#2ec4b6", "#e3a23b", "#5b8dd6", "#d9483b", "#7cc46a", "#c45aa8"];
const PRIORITY_RANK: Record<Priority, number> = { urgent: 0, high: 1, medium: 2, low: 3 };
const MAX_PROJECTS = 6, MAX_TASKS = 12, MAX_NOTES = 8, MAX_TITLE = 28;

const clean = (s: string): string => fontSafe(s).slice(0, MAX_TITLE) || "UNTITLED";

export interface ArcadeSource {
  projects: Project[];
  notes: Note[];
  cards: TaskCard[];
  columns: BoardColumn[];
  tags: Tag[];
  workspaceId: string | null;
  now?: Date;
}

/** Minutes between 09:00 on `now`'s day and the end of the due day. */
function dueMinutes(due: string | undefined, now: Date, seed: number): { dueMin: number; overdue: boolean; dueScope: DueScope } {
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
  // Today's work lands inside the 09:00–18:00 shift.
  return { dueMin: Math.min(520, Math.max(45, mins)), overdue: false, dueScope: "today" };
}

export function buildArcadeData(src: ArcadeSource): ArcadeData {
  const now = src.now ?? new Date();
  const inWs = <T extends { workspaceId: string }>(x: T) => !src.workspaceId || x.workspaceId === src.workspaceId;
  const colType = new Map(src.columns.map((c) => [c.id, c.type]));
  const open = src.cards.filter((c) => inWs(c) && !c.archivedAt && colType.get(c.columnId) !== "done");
  const notes = src.notes.filter((n) => inWs(n) && !n.archivedAt && !n.deletedAt && n.title.trim());
  const projects = src.projects
    .filter((p) => inWs(p) && !p.archivedAt)
    .map((p) => ({
      p,
      cards: open.filter((c) => c.projectId === p.id),
      notes: notes.filter((n) => n.projectId === p.id),
    }))
    .filter((x) => x.cards.length || x.notes.length)
    .sort((a, b) => b.cards.length + b.notes.length - (a.cards.length + a.notes.length))
    .slice(0, MAX_PROJECTS);

  const selected = projects.map((x) => ({
    p: x.p,
    tasks: [...x.cards]
      .sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || a.order - b.order)
      .slice(0, MAX_TASKS),
    notes: [...x.notes]
      .sort((a, b) => Number(b.isPinned) - Number(a.isPinned) || b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, MAX_NOTES),
  }));
  const noteIds = new Set(selected.flatMap((x) => x.notes.map((n) => n.id)));
  const out: ArcadeProject[] = selected.map((x, i) => ({
    id: x.p.id,
    name: clean(x.p.name),
    accent: ACCENTS[i % ACCENTS.length],
    biome: BIOME_ORDER[i % BIOME_ORDER.length],
    tasks: x.tasks.map((c, k) => ({
      title: clean(c.title),
      priority: c.priority,
      column: colType.get(c.columnId) ?? "todo",
      ...dueMinutes(c.dueDate, now, i * 31 + k),
    })),
    notes: x.notes.map((n) => ({
      id: n.id,
      title: clean(n.title),
      words: Math.max(80, (n.contentText?.length ?? 0) * 6),
      links: n.linkedNoteIds.filter((id) => id !== n.id && noteIds.has(id)),
    })),
  }));
  const tags = src.tags.filter(inWs).map((t) => clean(t.name)).slice(0, 12);
  const data: ArcadeData = { projects: out, tags, labels: [], demo: false };
  data.labels = interleave(data);
  return enough(data) ? data : DEMO_DATA;
}

/** Real data has to fill a few games' worth of targets, else play the demo. */
function enough(d: ArcadeData): boolean {
  const tasks = d.projects.reduce((s, p) => s + p.tasks.length, 0);
  return d.projects.length >= 2 && tasks >= 6 && d.labels.length >= 12;
}

/** Project, note, task, tag, round-robin, so neighbouring bricks differ. */
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

// ── Demo workspace ───────────────────────────────────────────────────────────
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

function demoData(): ArcadeData {
  let n = 0;
  const projects: ArcadeProject[] = DEMO.map(([name, tasks, notes], i) => ({
    id: `demo-${i}`,
    name,
    accent: ACCENTS[i % ACCENTS.length],
    biome: BIOME_ORDER[i % BIOME_ORDER.length],
    tasks: tasks.map(([title, priority, dueMin]) => ({ title, priority, dueMin, overdue: dueMin < 0, column: "todo" as ColumnType })),
    notes: notes.map(([title, words, links]) => ({ id: `n${n++}`, title, words, links: links.map((j) => `n${j}`) })),
  }));
  const tags = ["MOBILE", "DESIGN", "URGENT", "HOME", "RESEARCH", "LATER", "Q1", "BLOCKED", "BUG", "COPY"];
  const data: ArcadeData = { projects, tags, labels: [], demo: true };
  data.labels = interleave(data);
  return data;
}

export const DEMO_DATA: ArcadeData = demoData();
