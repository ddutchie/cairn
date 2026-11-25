/**
 * Shared mobile arcade data loader for Wayfinder and Inbox Zero. A pure leaf
 * query (`getDb` + `LIVE`): turns live projects, open tasks (with due dates),
 * and notes (with wikilinks and rough word count) into game-ready records,
 * falling back to a demo workspace when the phone's workspace is thin.
 */

import type { Priority } from "@cairn/shared/types/domain";
import { ACCENTS, DEMO_ARCADE_PROJECTS, arcadeNoteLinks, cleanArcadeTitle, dueMinutes, type ArcadeProject } from "@cairn/shared/arcade/pixel/arcade-data";
import { BIOME_ORDER } from "@cairn/shared/arcade/pixel/terrain";
import { buildOffice, type OfficeSource } from "@cairn/shared/arcade/workspace/build";
import type { OfficeData } from "@cairn/shared/arcade/workspace/data";
import { getDb } from "./index";
import { LIVE, NOT_CONFLICT } from "./sql";

export { ACCENTS, DEMO_ARCADE_PROJECTS, dueMinutes, type ArcadeNote, type ArcadeProject, type ArcadeTask } from "@cairn/shared/arcade/pixel/arcade-data";

const PRIORITIES: Priority[] = ["low", "medium", "high", "urgent"];
const PRIORITY_RANK: Record<Priority, number> = { urgent: 0, high: 1, medium: 2, low: 3 };
const MAX_PROJECTS = 6;
const MAX_TASKS = 12;
const MAX_NOTES = 8;

function parseIds(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
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
      const tasks = db.getAllSync<{ id: string; title: string; priority: string; due_date: string | null }>(
        `SELECT c.id, c.title, c.priority, c.due_date FROM task_cards c LEFT JOIN board_columns col ON col.id = c.column_id
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

  const links = arcadeNoteLinks(gathered.flatMap((x) => x.notes.map((n) => ({ id: n.id, title: n.title, body: n.content, linkedIds: parseIds(n.linked_note_ids) }))));

  return gathered.map((x, i) => ({
    id: x.p.id,
    name: cleanArcadeTitle(x.p.name),
    accent: ACCENTS[i % ACCENTS.length],
    biome: BIOME_ORDER[i % BIOME_ORDER.length],
    tasks: x.tasks
      .map((t) => ({
        id: t.id,
        title: cleanArcadeTitle(t.title),
        priority: (PRIORITIES as string[]).includes(t.priority) ? (t.priority as Priority) : "medium",
        due: t.due_date,
      }))
      .sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority])
      .slice(0, MAX_TASKS)
      .map((t, k) => ({
        id: t.id,
        title: t.title,
        priority: t.priority,
        ...dueMinutes(t.due, now, i * 31 + k),
      })),
    notes: x.notes.map((n) => ({
      id: n.id,
      title: cleanArcadeTitle(n.title),
      words: Math.max(80, Math.round((n.content?.trim().length ?? 0) / 5)),
      links: links.get(n.id) ?? [],
    })),
  }));
}

/**
 * Every open task and live note in these projects, with none of the per-project caps the games use.
 * Angler checks its saved fish against this, so a task that didn't make the cut isn't taken for done.
 */
export function listArcadeLiveIds(projectIds: string[]): string[] {
  if (!projectIds.length) return [];
  const db = getDb();
  const marks = projectIds.map(() => "?").join(", ");
  const tasks = db.getAllSync<{ id: string }>(
    `SELECT c.id FROM task_cards c LEFT JOIN board_columns col ON col.id = c.column_id
     WHERE c.project_id IN (${marks}) AND c.deleted_at IS NULL AND c.archived_at IS NULL
       AND COALESCE(col.type, '') <> 'done'`,
    ...projectIds,
  );
  const notes = db.getAllSync<{ id: string }>(
    `SELECT id FROM notes WHERE project_id IN (${marks}) AND type = 'note' AND ${LIVE} AND ${NOT_CONFLICT}`,
    ...projectIds,
  );
  return [...tasks.map((t) => t.id), ...notes.map((n) => n.id)];
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

/** The office, plus a cheap fingerprint (counts + newest write) so the host can poll for changes. */
export interface OfficeLoad {
  office: OfficeData;
  fingerprint: string;
  /** First workspace row, for per-workspace decor keys. */
  workspaceId: string | null;
}

/**
 * The idle office's mirror of the phone's workspace, via `buildOffice`.
 * Mobile has no `completed_at` on cards, so a done-column card counts for the
 * done board when it was touched in the last seven days (an edit also counts).
 */
export function loadOfficeData(now = new Date()): OfficeLoad {
  const db = getDb();
  const ws = db.getFirstSync<{ id: string; name: string } | null>(`SELECT id, name FROM workspaces ORDER BY updated_at DESC LIMIT 1`);
  const projects = db.getAllSync<{ id: string; name: string }>(
    `SELECT id, name FROM projects WHERE ${LIVE} ORDER BY updated_at DESC`,
  );
  const columns = db.getAllSync<{ id: string; project_id: string; name: string; type: string; order: number }>(
    `SELECT id, project_id, name, type, "order" FROM board_columns WHERE deleted_at IS NULL ORDER BY "order" ASC`,
  );
  const cards = db.getAllSync<{
    id: string; project_id: string; column_id: string; title: string; priority: string;
    due_date: string | null; assignee: string | null; order: number; updated_at: string; archived_at: string | null;
  }>(
    `SELECT id, project_id, column_id, title, priority, due_date, assignee, "order", updated_at, archived_at
     FROM task_cards WHERE deleted_at IS NULL`,
  );
  const notes = db.getAllSync<{ id: string; project_id: string; title: string; is_pinned: number; updated_at: string }>(
    `SELECT id, project_id, title, is_pinned, updated_at FROM notes
     WHERE project_id IS NOT NULL AND type = 'note' AND ${LIVE} AND ${NOT_CONFLICT}`,
  );
  const src: OfficeSource = {
    workspaceName: ws?.name ?? "Workspace",
    workspaceId: null,
    projects: projects.map((p) => ({ id: p.id, workspaceId: "", name: p.name }) as never),
    columns: columns.map((c) => ({ id: c.id, projectId: c.project_id, workspaceId: "", name: c.name, type: c.type, order: c.order }) as never),
    cards: cards.map((c) => ({
      id: c.id, projectId: c.project_id, columnId: c.column_id, workspaceId: "", title: c.title,
      priority: c.priority, dueDate: c.due_date, assignee: c.assignee, order: c.order,
      updatedAt: c.updated_at, archivedAt: c.archived_at, completedAt: c.updated_at,
    }) as never),
    notes: notes.map((n) => ({
      id: n.id, projectId: n.project_id, workspaceId: "", title: n.title,
      isPinned: n.is_pinned === 1, updatedAt: n.updated_at,
    }) as never),
    now,
  };
  const office = buildOffice(src);
  const fp = db.getFirstSync<{ n: number; m: string | null } | null>(
    `SELECT (SELECT COUNT(*) FROM projects) + (SELECT COUNT(*) FROM task_cards) + (SELECT COUNT(*) FROM notes) + (SELECT COUNT(*) FROM board_columns) AS n,
            (SELECT MAX(updated_at) FROM (SELECT updated_at FROM projects UNION ALL SELECT updated_at FROM task_cards UNION ALL SELECT updated_at FROM notes UNION ALL SELECT updated_at FROM board_columns)) AS m`,
  );
  return { office, fingerprint: `${fp?.n ?? 0}|${fp?.m ?? ""}`, workspaceId: ws?.id ?? null };
}
