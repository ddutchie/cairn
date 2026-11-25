/**
 * Builds the office from the workspace as the stores hold it: projects, board
 * columns, cards and notes. Pure, so both hosts and the tests share it.
 */

import type { BoardColumn, TaskCard } from "../../types/board";
import type { Note } from "../../types/notes";
import type { Project } from "../../types/workspace";
import { getDueDateStatus } from "../../format/date";
import { ACCENTS } from "../pixel/arcade-data";
import { officeTitle, zoneForColumn, type OfficeCard, type OfficeColumn, type OfficeData, type OfficeProject, type Zone } from "./data";

export interface OfficeSource {
  workspaceName: string;
  workspaceId: string | null;
  projects: readonly Project[];
  columns: readonly BoardColumn[];
  cards: readonly TaskCard[];
  notes: readonly Note[];
  now?: Date;
}

const WEEK_MS = 7 * 86_400_000;
const ZONE_ORDER: Record<Zone, number> = { doing: 0, review: 1, backlog: 2, done: 3 };

export function buildOffice(src: OfficeSource): OfficeData {
  const now = src.now ?? new Date();
  const inWs = <T extends { workspaceId: string }>(x: T) => !src.workspaceId || x.workspaceId === src.workspaceId;

  // Each column's zone. A custom column sits with the zone before or after the first in-progress column.
  const zone = new Map<string, Zone>();
  const byProject = new Map<string, BoardColumn[]>();
  for (const c of src.columns) {
    if (!inWs(c)) continue;
    const list = byProject.get(c.projectId) ?? [];
    list.push(c);
    byProject.set(c.projectId, list);
  }
  for (const cols of byProject.values()) {
    cols.sort((a, b) => a.order - b.order);
    let afterDoing = false;
    for (const c of cols) {
      zone.set(c.id, zoneForColumn(c.type, afterDoing));
      if (c.type === "in_progress") afterDoing = true;
    }
  }

  const projects: OfficeProject[] = [];
  const live = src.projects.filter((p) => inWs(p) && !p.archivedAt);
  for (const p of live) {
    const cards: OfficeCard[] = [];
    const order = new Map<string, number>();
    let doneThisWeek = 0;
    for (const c of src.cards) {
      if (c.projectId !== p.id || c.archivedAt) continue;
      const z = zone.get(c.columnId) ?? "backlog";
      if (z === "done") {
        const at = c.completedAt ? Date.parse(c.completedAt) : NaN;
        if (Number.isFinite(at) && now.getTime() - at < WEEK_MS) doneThisWeek++;
        continue;
      }
      const due = getDueDateStatus(c.dueDate, now.getTime());
      cards.push({
        id: c.id,
        title: officeTitle(c.title),
        columnId: c.columnId,
        priority: c.priority,
        zone: z,
        assignee: c.assignee?.trim() ? officeTitle(c.assignee) : null,
        overdue: due === "overdue",
        dueToday: due === "today",
        dueKey: /^\d{4}-\d{2}-\d{2}$/.test(c.dueDate ?? "") ? (c.dueDate as string) : null,
      });
      order.set(c.id, c.order);
    }
    cards.sort((a, b) => ZONE_ORDER[a.zone] - ZONE_ORDER[b.zone] || (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
    const notes = src.notes
      .filter((n) => n.projectId === p.id && !n.archivedAt && !n.deletedAt && n.title.trim())
      .sort((a, b) => Number(b.isPinned) - Number(a.isPinned) || b.updatedAt.localeCompare(a.updatedAt))
      .map((n) => ({ id: n.id, title: officeTitle(n.title), pinned: n.isPinned, rev: n.updatedAt }));
    const columns: OfficeColumn[] = (byProject.get(p.id) ?? []).map((c) => ({ id: c.id, name: officeTitle(c.name) || "COLUMN", zone: zone.get(c.id) ?? "backlog" }));
    projects.push({ id: p.id, name: officeTitle(p.name), accent: "", columns, cards, notes, doneThisWeek });
  }
  // Busiest rooms first; colours follow that order so a room keeps its colour while the order holds.
  projects.sort((a, b) => b.cards.length + b.notes.length - (a.cards.length + a.notes.length));
  const shown = projects.filter((p) => p.cards.length || p.notes.length || p.doneThisWeek);
  shown.forEach((p, i) => (p.accent = ACCENTS[i % ACCENTS.length]));
  return { workspace: officeTitle(src.workspaceName) || "WORKSPACE", projects: shown, demo: false };
}
