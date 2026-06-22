"use client";

/**
 * useProjectMetrics — derives all computed values for the ProjectOverview page.
 *
 * Centralises date calculations, priority counts, and activity grouping
 * so the main component stays under 150 lines.
 */

import { useCairnStore } from "@/store";
import { useShallow } from "zustand/react/shallow";
import { COLUMN_TYPE_ORDER } from "@/lib/constants";
import { CairnEvents } from "@/lib/events";
import type { Note, TaskCard, BoardColumn } from "@/types";

export interface ActivityItem {
  id: string;
  type: "note" | "card";
  title: string;
  subtitle: string | null;
  updatedAt: string;
  onClick: () => void;
}

export interface ActivityGroup {
  label: string;
  items: ActivityItem[];
}

export interface ProjectMetrics {
  notes: Note[];
  columns: BoardColumn[];
  allCards: TaskCard[];
  doneCards: TaskCard[];
  openCards: TaskCard[];
  completionRate: number;
  today: Date;
  dueCards: TaskCard[];
  overdueCount: number;
  priorityCounts: { urgent: number; high: number; medium: number; low: number };
  hasAnyCategorised: boolean;
  pinnedNotes: Note[];
  recentNotes: Note[];
  projectTags: import("@/types").Tag[];
  activityByDay: ActivityGroup[];
}

function dayLabel(iso: string): string {
  const d = new Date(iso);
  d.setHours(0, 0, 0, 0);
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const diff = Math.round((now.getTime() - d.getTime()) / 86_400_000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function useProjectMetrics(projectId: string | null): ProjectMetrics | null {
  const {
    projects,
    getProjectNotes,
    getProjectColumns,
    getProjectCards,
    getColumnCards,
    getTagById,
    setView,
  } = useCairnStore(useShallow((s) => ({
    projects:          s.projects,
    getProjectNotes:   s.getProjectNotes,
    getProjectColumns: s.getProjectColumns,
    getProjectCards:   s.getProjectCards,
    getColumnCards:    s.getColumnCards,
    getTagById:        s.getTagById,
    setView:           s.setView,
  })));

  const project = projects.find((p) => p.id === projectId);
  if (!project || !projectId) return null;

  const notes     = getProjectNotes(projectId);
  const columns   = getProjectColumns(projectId).sort(
    (a, b) => COLUMN_TYPE_ORDER.indexOf(a.type) - COLUMN_TYPE_ORDER.indexOf(b.type)
  );
  const allCards  = getProjectCards(projectId);

  const doneCol   = columns.find((c) => c.type === "done");
  const doneCards = doneCol ? getColumnCards(doneCol.id) : [];
  const openCards = allCards.filter((c) => c.columnId !== doneCol?.id);

  const completionRate = allCards.length > 0
    ? Math.round((doneCards.length / allCards.length) * 100)
    : 0;

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const in7Days = new Date(today);
  in7Days.setDate(today.getDate() + 7);

  const dueCards = openCards
    .filter((c) => c.dueDate)
    .filter((c) => new Date(c.dueDate!) <= in7Days)
    .sort((a, b) => new Date(a.dueDate!).getTime() - new Date(b.dueDate!).getTime());

  const overdueCount = dueCards.filter((c) => new Date(c.dueDate!) < today).length;

  const priorityCounts = {
    urgent: openCards.filter((c) => c.priority === "urgent").length,
    high:   openCards.filter((c) => c.priority === "high").length,
    medium: openCards.filter((c) => c.priority === "medium").length,
    low:    openCards.filter((c) => c.priority === "low").length,
  };
  const hasAnyCategorised = Object.values(priorityCounts).some((n) => n > 0);

  const pinnedNotes = notes.filter((n) => n.isPinned).slice(0, 4);
  const recentNotes = notes.filter((n) => !n.isPinned).slice(0, 5);

  const projectTags = project.tagIds.map((tid) => getTagById(tid)).filter(Boolean) as import("@/types").Tag[];

  const activityItems: ActivityItem[] = [
    ...notes.map((n) => ({
      id: n.id, type: "note" as const,
      title: n.title, subtitle: null,
      updatedAt: n.updatedAt,
      onClick: () => { setView("notes"); window.dispatchEvent(CairnEvents.selectNote(n.id)); },
    })),
    ...allCards.map((c) => {
      const col = columns.find((col) => col.id === c.columnId);
      return {
        id: c.id, type: "card" as const,
        title: c.title, subtitle: col?.name ?? null,
        updatedAt: c.updatedAt,
        onClick: () => { setView("board"); window.dispatchEvent(CairnEvents.openCard(c.id)); },
      };
    }),
  ]
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .slice(0, 20);

  const activityByDay: ActivityGroup[] = [];
  for (const item of activityItems) {
    const label = dayLabel(item.updatedAt);
    const group = activityByDay.find((g) => g.label === label);
    if (group) group.items.push(item);
    else activityByDay.push({ label, items: [item] });
  }

  return {
    notes, columns, allCards, doneCards, openCards,
    completionRate, today, dueCards, overdueCount,
    priorityCounts, hasAnyCategorised,
    pinnedNotes, recentNotes, projectTags, activityByDay,
  };
}
