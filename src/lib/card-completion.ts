/**
 * Renderer mirror of the schema-v58 `completed_at` triggers. The DB stamps
 * `completed_at` when a card enters a done-type column, but the change feed
 * skips a window's own writes, so the renderer's optimistic card would never
 * learn the value. Apply the same rule locally wherever a card changes column.
 */

import { now } from "@/lib/utils";
import type { BoardColumn, TaskCard } from "@/types";

export function completedAtAfterMove(
  card: Pick<TaskCard, "columnId" | "completedAt">,
  targetColumnId: string,
  columns: readonly Pick<BoardColumn, "id" | "type">[],
): string | undefined {
  if (card.columnId === targetColumnId) return card.completedAt;
  const isDone = columns.find((c) => c.id === targetColumnId)?.type === "done";
  return isDone ? card.completedAt ?? now() : undefined;
}
