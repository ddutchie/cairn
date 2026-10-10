import { computeProjectMetrics } from "@cairn/shared/overview/metrics";
import { getDueDateStatus } from "@cairn/shared/format/date";
import type { ProjectOverviewData } from "@/db/queries";
import { buildRadarAxes, type RadarAxis } from "./HealthRadar";

/**
 * One project's headline numbers — the Overview segment and the projects
 * tree's card read the same summary, so they never disagree. Built on the
 * shared computeProjectMetrics(), like desktop.
 */
export interface ProjectSummary {
  metrics: ReturnType<typeof computeProjectMetrics>;
  todayCount: number;
  /** The open column holding the most cards (null when none hold any). */
  bottleneck: { name: string; count: number } | null;
  radarAxes: RadarAxis[];
}

export function summarizeProject(data: ProjectOverviewData): ProjectSummary {
  const metrics = computeProjectMetrics({
    columns: data.columns.map((c) => ({ id: c.id, name: c.name, type: c.type })),
    cards: data.cards.map((c) => ({
      id: c.id,
      columnId: c.column_id,
      title: c.title,
      priority: c.priority,
      dueDate: c.due_date ?? null,
      updatedAt: c.updated_at,
    })),
    notes: data.notes.map((n) => ({
      id: n.id,
      title: n.title,
      content: n.content,
      isPinned: !!n.is_pinned,
      updatedAt: n.updated_at,
      tagIds: [],
    })),
  });

  const todayCount = metrics.dueCards.filter((c) => getDueDateStatus(c.dueDate) === "today").length;

  const doneColId = metrics.columns.find((c) => c.type === "done")?.id;
  let bottleneck: { name: string; count: number } | null = null;
  let max = -1;
  for (const col of metrics.columns) {
    if (col.id === doneColId) continue;
    const count = metrics.allCards.filter((c) => c.columnId === col.id).length;
    if (count > max) {
      max = count;
      bottleneck = { name: col.name, count };
    }
  }
  if (bottleneck && bottleneck.count === 0) bottleneck = null;

  const radarAxes = buildRadarAxes({
    completionRate: metrics.completionRate,
    openCards: metrics.openCards,
    overdueCount: metrics.overdueCount,
    todayCount,
    notes: { length: metrics.totalNotes },
    pinnedNotes: metrics.pinnedNotes,
    recentNotes: metrics.recentNotes,
    bottleneck,
    priorityCounts: metrics.priorityCounts,
    columns: metrics.columns as unknown as { id: string; type: string }[],
    allCards: metrics.allCards,
    activityByDay: metrics.activityByDay as unknown as { items: unknown[] }[],
  });

  return { metrics, todayCount, bottleneck, radarAxes };
}
