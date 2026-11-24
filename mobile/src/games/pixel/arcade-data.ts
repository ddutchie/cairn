/**
 * Pure arcade project types and demo fallback workspace shared by Inbox Zero,
 * Wayfinder, and their unit tests (no SQLite or React Native imports).
 */

import type { Priority } from "@cairn/shared/types/domain";
import { BIOME_ORDER, type BiomeName } from "./terrain";

export interface ArcadeTask {
  title: string;
  priority: Priority;
  /** Minutes after 09:00 today it is due; negative = already overdue. */
  dueMin: number;
  overdue: boolean;
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

export const ACCENTS = ["#2ec4b6", "#e3a23b", "#5b8dd6", "#d9483b", "#7cc46a", "#c45aa8"];

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
    tasks: tasks.map(([title, priority, dueMin]) => ({ title, priority, dueMin, overdue: dueMin < 0 })),
    notes: notes.map(([title, words, links]) => ({ id: `n${n++}`, title, words, links: links.map((j) => `n${j}`) })),
  }));
})();
