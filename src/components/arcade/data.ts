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
  arcadeNoteLinks,
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
  // Bodies load lazily on desktop: use what's loaded, else the excerpt (its wikilinks still count).
  const links = arcadeNoteLinks(selected.flatMap((x) => x.notes.map((n) => ({ id: n.id, title: n.title, body: n.content ?? n.contentText, linkedIds: n.linkedNoteIds }))));
  const out: ArcadeProject[] = selected.map((x, i) => ({
    id: x.p.id,
    name: cleanArcadeTitle(x.p.name),
    accent: ACCENTS[i % ACCENTS.length],
    biome: BIOME_ORDER[i % BIOME_ORDER.length],
    tasks: x.tasks.map((c, k) => ({
      id: c.id,
      title: cleanArcadeTitle(c.title),
      priority: c.priority,
      ...dueMinutes(c.dueDate, now, i * 31 + k),
    })),
    notes: x.notes.map((n) => ({
      id: n.id,
      title: cleanArcadeTitle(n.title),
      // A loaded body gives a real size (about five characters a word); the ≤200-char excerpt only a guess.
      words: Math.max(80, n.content ? Math.round(n.content.trim().length / 5) : (n.contentText?.length ?? 0) * 6),
      links: links.get(n.id) ?? [],
    })),
  }));
  const tags = src.tags.filter(inWs).map((t) => cleanArcadeTitle(t.name)).slice(0, 12);
  // Uncapped: every open task and live note in the projects shown, for Angler's tank cleanup.
  // Built from the workspace sources (not the title-filtered display lists) so a
  // live note with a blank title still protects its saved fish.
  const shown = new Set(projects.map((x) => x.p.id));
  const liveIds = [
    ...open.filter((c) => shown.has(c.projectId)).map((c) => c.id),
    ...src.notes.filter((n) => inWs(n) && !n.archivedAt && !n.deletedAt && shown.has(n.projectId)).map((n) => n.id),
  ];
  const data: ArcadeData = { projects: out, tags, labels: [], demo: false, liveIds };
  data.labels = interleave(data);
  return enough(data) ? data : DEMO_DATA;
}

function enough(d: ArcadeData): boolean {
  const tasks = d.projects.reduce((s, p) => s + p.tasks.length, 0);
  return d.projects.length >= 2 && tasks >= 6 && d.labels.length >= 12;
}
