"use client";

/**
 * useProjectMetrics — derives all computed values for the ProjectOverview page.
 *
 * Adapts store rows into the shared computeProjectMetrics (also used by
 * mobile), then adds the desktop-only bits: tags, click-through on activity
 * items, and the delivery signals (shipped / at risk).
 */

import { useCairnStore } from "@/store";
import { useShallow } from "zustand/react/shallow";
import { revealNote, revealCard } from "@/lib/events";
import type { Note, TaskCard, BoardColumn, Tag } from "@/types";
import { shippedSince, atRiskCards, startOfDayAgo, type AtRiskCard } from "../../../../shared/overview/delivery";
import { computeProjectMetrics, type ActivityItem as BaseActivityItem } from "../../../../shared/overview/metrics";

export interface ActivityItem extends BaseActivityItem {
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
  projectTags: Tag[];
  activityByDay: ActivityGroup[];
  /** Cards completed in the last 7 days (incl. archived), newest first. */
  shippedCards: TaskCard[];
  /** Open cards that are overdue, blocked near their due date, or stale. */
  atRisk: AtRiskCard<TaskCard>[];
}

export function useProjectMetrics(projectId: string | null): ProjectMetrics | null {
  const {
    projects,
    cards,
    getProjectNotes,
    getProjectColumns,
    getProjectCards,
    getTagById,
    setView,
  } = useCairnStore(useShallow((s) => ({
    projects:          s.projects,
    cards:             s.cards,
    getProjectNotes:   s.getProjectNotes,
    getProjectColumns: s.getProjectColumns,
    getProjectCards:   s.getProjectCards,
    getTagById:        s.getTagById,
    setView:           s.setView,
  })));

  const project = projects.find((p) => p.id === projectId);
  if (!project || !projectId) return null;

  // The numbers come from the shared, platform-agnostic computeProjectMetrics
  // (mobile uses the same function), so desktop and mobile can't drift.
  const notes = getProjectNotes(projectId);
  const base = computeProjectMetrics({
    notes,
    cards: getProjectCards(projectId),
    columns: getProjectColumns(projectId),
  });
  const { columns, allCards } = base;

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const projectTags = project.tagIds.map((tid) => getTagById(tid)).filter(Boolean) as Tag[];

  // Same items, plus the desktop click-through.
  const activityByDay: ActivityGroup[] = base.activityByDay.map((g) => ({
    label: g.label,
    items: g.items.map((item) => ({
      ...item,
      onClick: item.type === "note" ? () => revealNote(setView, item.id) : () => revealCard(setView, item.id),
    })),
  }));

  const shippedCards = shippedSince(cards.filter((c) => c.projectId === projectId), startOfDayAgo(6));
  const atRisk = atRiskCards(allCards, columns);

  return {
    notes,
    columns, allCards,
    doneCards: base.doneCards,
    openCards: base.openCards,
    completionRate: base.completionRate,
    today,
    dueCards: base.dueCards,
    overdueCount: base.overdueCount,
    priorityCounts: base.priorityCounts,
    hasAnyCategorised: base.hasAnyCategorised,
    pinnedNotes: base.pinnedNotes,
    recentNotes: base.recentNotes,
    projectTags, activityByDay,
    shippedCards, atRisk,
  };
}
