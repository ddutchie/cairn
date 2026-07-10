/**
 * computeProjectMetrics — the pure "brain" behind the project Overview.
 *
 * Ported from the desktop hook src/components/layout/project-overview/
 * useProjectMetrics.ts into a platform-agnostic function so desktop and mobile
 * derive identical numbers (completion %, due-soon, priority counts, activity
 * grouping). It has NO React / store / DOM dependencies — it takes already-read
 * rows in a small normalized shape and returns plain data. Each platform adapts
 * its own row shape (desktop camelCase, mobile snake_case) at the call site.
 *
 * Behaviour is byte-for-byte the same as the desktop original.
 */

import { getDueDateStatus } from "../format/date";
import { COLUMN_TYPE_ORDER, type ColumnType } from "../ui/constants";

/** Normalized note input — only the fields the Overview needs. */
export interface MetricsNote {
  id: string;
  title: string;
  /** Plaintext/markdown body used only for previews by the view (optional). */
  content?: string | null;
  isPinned: boolean;
  updatedAt: string;
  tagIds: string[];
}

/** Normalized card input. */
export interface MetricsCard {
  id: string;
  columnId: string;
  title: string;
  priority: string;
  dueDate: string | null;
  updatedAt: string;
}

/** Normalized column input. */
export interface MetricsColumn {
  id: string;
  name: string;
  type: ColumnType | string;
}

export interface MetricsInput {
  columns: MetricsColumn[];
  cards: MetricsCard[];
  notes: MetricsNote[];
}

export interface ActivityItem {
  id: string;
  type: "note" | "card";
  title: string;
  subtitle: string | null;
  updatedAt: string;
}

export interface ActivityGroup {
  label: string;
  items: ActivityItem[];
}

export interface PriorityCounts {
  urgent: number;
  high: number;
  medium: number;
  low: number;
}

export interface ProjectMetrics {
  columns: MetricsColumn[];
  allCards: MetricsCard[];
  doneCards: MetricsCard[];
  openCards: MetricsCard[];
  /** doneCards / allCards as a 0–100 integer (0 when there are no cards). */
  completionRate: number;
  /** Open, dated cards due within the next 7 days, soonest first. */
  dueCards: MetricsCard[];
  overdueCount: number;
  priorityCounts: PriorityCounts;
  hasAnyCategorised: boolean;
  pinnedNotes: MetricsNote[];
  recentNotes: MetricsNote[];
  totalNotes: number;
  /** Merged notes + cards, most-recent 20, grouped by day label. */
  activityByDay: ActivityGroup[];
}

/** Today / Yesterday / "Jan 5" grouping label (local calendar day). */
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

export function computeProjectMetrics(input: MetricsInput): ProjectMetrics {
  const notes = input.notes;
  const columns = [...input.columns].sort(
    (a, b) => COLUMN_TYPE_ORDER.indexOf(a.type as ColumnType) - COLUMN_TYPE_ORDER.indexOf(b.type as ColumnType),
  );
  const allCards = input.cards;

  const doneCol = columns.find((c) => c.type === "done");
  const doneCards = doneCol ? allCards.filter((c) => c.columnId === doneCol.id) : [];
  const openCards = allCards.filter((c) => c.columnId !== doneCol?.id);

  const completionRate = allCards.length > 0 ? Math.round((doneCards.length / allCards.length) * 100) : 0;

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const in7Days = new Date(today);
  in7Days.setDate(today.getDate() + 7);

  const dueCards = openCards
    .filter((c) => c.dueDate)
    .filter((c) => new Date(c.dueDate as string) <= in7Days)
    .sort((a, b) => new Date(a.dueDate as string).getTime() - new Date(b.dueDate as string).getTime());

  const overdueCount = dueCards.filter((c) => getDueDateStatus(c.dueDate) === "overdue").length;

  const priorityCounts: PriorityCounts = {
    urgent: openCards.filter((c) => c.priority === "urgent").length,
    high: openCards.filter((c) => c.priority === "high").length,
    medium: openCards.filter((c) => c.priority === "medium").length,
    low: openCards.filter((c) => c.priority === "low").length,
  };
  const hasAnyCategorised = Object.values(priorityCounts).some((n) => n > 0);

  const pinnedNotes = notes.filter((n) => n.isPinned).slice(0, 4);
  const recentNotes = notes.filter((n) => !n.isPinned).slice(0, 5);

  const activityItems: ActivityItem[] = [
    ...notes.map((n) => ({
      id: n.id,
      type: "note" as const,
      title: n.title,
      subtitle: null,
      updatedAt: n.updatedAt,
    })),
    ...allCards.map((c) => {
      const col = columns.find((cc) => cc.id === c.columnId);
      return {
        id: c.id,
        type: "card" as const,
        title: c.title,
        subtitle: col?.name ?? null,
        updatedAt: c.updatedAt,
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
    columns,
    allCards,
    doneCards,
    openCards,
    completionRate,
    dueCards,
    overdueCount,
    priorityCounts,
    hasAnyCategorised,
    pinnedNotes,
    recentNotes,
    totalNotes: notes.length,
    activityByDay,
  };
}
