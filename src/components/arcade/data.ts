/**
 * What the arcade games read from the workspace: projects with their open
 * tasks and notes, note-to-note links, and tag names. Built once when a game
 * starts (the games never write anything back). A thin workspace falls back to
 * a demo workspace from @cairn/shared/arcade/pixel/arcade-data.
 */

import type { BoardColumn, TaskCard } from "@cairn/shared/types/board";
import type { Priority } from "@cairn/shared/types/domain";
import type { Note } from "@cairn/shared/types/notes";
import type { Project, Tag } from "@cairn/shared/types/workspace";
import {
  ACCENTS,
  DEMO_DATA,
  cleanArcadeTitle,
  dueMinutes,
  interleave,
  type ArcadeData,
  type ArcadeNote,
  type ArcadeProject,
  type ArcadeTask,
  type DueScope,
} from "@cairn/shared/arcade/pixel/arcade-data";
import type { EntityKind, Label } from "@cairn/shared/arcade/pixel/kinds";
import { BIOME_ORDER, type BiomeName } from "@cairn/shared/arcade/pixel/terrain";

export {
  ACCENTS,
  DEMO_DATA,
  interleave,
  type ArcadeData,
  type ArcadeNote,
  type ArcadeProject,
  type ArcadeTask,
  type DueScope,
  type EntityKind,
  type Label,
  type BiomeName,
};

const PRIORITY_RANK: Record<Priority, number> = { urgent: 0, high: 1, medium: 2, low: 3 };
const MAX_PROJECTS = 6;
const MAX_TASKS = 12;
const MAX_NOTES = 8;

export interface ArcadeSource {
  projects: Project[];
  notes: Note[];
  cards: TaskCard[];
  columns: BoardColumn[];
  tags: Tag[];
  workspaceId: string | null;
  now?: Date;
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
    name: cleanArcadeTitle(x.p.name),
    accent: ACCENTS[i % ACCENTS.length],
    biome: BIOME_ORDER[i % BIOME_ORDER.length],
    tasks: x.tasks.map((c, k) => ({
      title: cleanArcadeTitle(c.title),
      priority: c.priority,
      ...dueMinutes(c.dueDate, now, i * 31 + k),
    })),
    notes: x.notes.map((n) => ({
      id: n.id,
      title: cleanArcadeTitle(n.title),
      words: Math.max(80, (n.contentText?.length ?? 0) * 6),
      links: n.linkedNoteIds.filter((id) => id !== n.id && noteIds.has(id)),
    })),
  }));
  const tags = src.tags.filter(inWs).map((t) => cleanArcadeTitle(t.name)).slice(0, 12);
  const data: ArcadeData = { projects: out, tags, labels: [], demo: false };
  data.labels = interleave(data);
  return enough(data) ? data : DEMO_DATA;
}

function enough(d: ArcadeData): boolean {
  const tasks = d.projects.reduce((s, p) => s + p.tasks.length, 0);
  return d.projects.length >= 2 && tasks >= 6 && d.labels.length >= 12;
}
