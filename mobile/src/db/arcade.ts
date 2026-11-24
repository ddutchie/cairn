/**
 * Shared mobile arcade data loader for Wayfinder and Inbox Zero. A pure leaf
 * query (`getDb` + `LIVE`): turns live projects, open tasks (with due dates),
 * and notes (with wikilinks and rough word count) into game-ready records,
 * falling back to a demo workspace when the phone's workspace is thin.
 */

import type { Priority } from "@cairn/shared/types/domain";
import { ACCENTS, DEMO_ARCADE_PROJECTS, type ArcadeProject } from "@/games/pixel/arcade-data";
import { BIOME_ORDER, hash2 } from "@/games/pixel/terrain";
import { getDb } from "./index";
import { LIVE, NOT_CONFLICT } from "./sql";

export { ACCENTS, DEMO_ARCADE_PROJECTS, type ArcadeNote, type ArcadeProject, type ArcadeTask } from "@/games/pixel/arcade-data";

const PRIORITIES: Priority[] = ["low", "medium", "high", "urgent"];
const PRIORITY_RANK: Record<Priority, number> = { urgent: 0, high: 1, medium: 2, low: 3 };
const MAX_PROJECTS = 6;
const MAX_TASKS = 12;
const MAX_NOTES = 8;
const MAX_TITLE = 28;

function clean(s: string): string {
  const out = s
    .toUpperCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Z0-9:.\-!/'?+ ,&#()]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return out.slice(0, MAX_TITLE) || "UNTITLED";
}

function parseIds(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function dueMinutes(due: string | null | undefined, now: Date, seed: number): { dueMin: number; overdue: boolean } {
  const start = new Date(now);
  start.setHours(9, 0, 0, 0);
  if (!due) return { dueMin: 120 + Math.round(hash2(seed, 3, 9) * 400), overdue: false };
  const d = new Date(due.length <= 10 ? `${due}T17:00:00` : due);
  if (Number.isNaN(d.getTime())) return { dueMin: 300, overdue: false };
  const mins = Math.round((d.getTime() - start.getTime()) / 60_000);
  if (d < start) return { dueMin: Math.max(-540, Math.min(-30, mins)), overdue: true };
  return { dueMin: Math.min(520, Math.max(45, mins)), overdue: false };
}

export function listArcadeProjects(now = new Date()): ArcadeProject[] {
  const db = getDb();
  const projects = db.getAllSync<{ id: string; name: string }>(
    `SELECT p.id, p.name FROM projects p
     WHERE p.deleted_at IS NULL AND p.archived_at IS NULL
     ORDER BY p.updated_at DESC`,
  );

  const gathered = projects
    .map((p) => {
      const tasks = db.getAllSync<{ title: string; priority: string; due_date: string | null }>(
        `SELECT c.title, c.priority, c.due_date FROM task_cards c LEFT JOIN board_columns col ON col.id = c.column_id
         WHERE c.project_id = ? AND c.deleted_at IS NULL AND c.archived_at IS NULL
           AND COALESCE(col.type, '') <> 'done'
         ORDER BY c."order" ASC, c.updated_at DESC`,
        p.id,
      );
      const notes = db.getAllSync<{ id: string; title: string; content: string | null; linked_note_ids: string; is_pinned: number }>(
        `SELECT id, title, content, linked_note_ids, is_pinned FROM notes
         WHERE project_id = ? AND type = 'note' AND ${LIVE} AND ${NOT_CONFLICT}
         ORDER BY is_pinned DESC, updated_at DESC
         LIMIT ${MAX_NOTES}`,
        p.id,
      );
      return { p, tasks, notes };
    })
    .filter((x) => x.tasks.length > 0 || x.notes.length > 0)
    .sort((a, b) => b.tasks.length + b.notes.length - (a.tasks.length + a.notes.length))
    .slice(0, MAX_PROJECTS);

  const noteIds = new Set(gathered.flatMap((x) => x.notes.map((n) => n.id)));

  return gathered.map((x, i) => ({
    id: x.p.id,
    name: clean(x.p.name),
    accent: ACCENTS[i % ACCENTS.length],
    biome: BIOME_ORDER[i % BIOME_ORDER.length],
    tasks: x.tasks
      .map((t) => ({
        title: clean(t.title),
        priority: (PRIORITIES as string[]).includes(t.priority) ? (t.priority as Priority) : "medium",
        due: t.due_date,
      }))
      .sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority])
      .slice(0, MAX_TASKS)
      .map((t, k) => ({
        title: t.title,
        priority: t.priority,
        ...dueMinutes(t.due, now, i * 31 + k),
      })),
    notes: x.notes.map((n) => ({
      id: n.id,
      title: clean(n.title),
      words: Math.max(80, (n.content?.trim().length ?? 0) * 6),
      links: parseIds(n.linked_note_ids).filter((id) => id !== n.id && noteIds.has(id)),
    })),
  }));
}

/** Load live workspace projects if rich enough for Wayfinder / Inbox Zero, else fall back to demo. */
export function loadArcadeProjects(now = new Date()): { projects: ArcadeProject[]; demo: boolean } {
  try {
    const projects = listArcadeProjects(now);
    const totalTasks = projects.reduce((s, p) => s + p.tasks.length, 0);
    if (projects.length >= 2 && totalTasks >= 6) return { projects, demo: false };
  } catch {
    // DB unavailable or empty — play the demo workspace.
  }
  return { projects: DEMO_ARCADE_PROJECTS, demo: true };
}
