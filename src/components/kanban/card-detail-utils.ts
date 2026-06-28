import type { TaskCard, BoardColumn } from "@/types";

/**
 * Pure blocker-candidate logic for the card-detail modal, extracted from
 * card-detail.tsx so the multi-clause exclusion filter is tested in isolation
 * (a silently-dropped clause here would let invalid blockers be selected).
 */

/** The set of column ids that are "done" columns within a given project. */
export function computeDoneColumnIds(columns: BoardColumn[], projectId: string): Set<string> {
  return new Set(
    columns.filter((c) => c.projectId === projectId && c.type === "done").map((c) => c.id),
  );
}

/**
 * Cards eligible to be added as blockers of `card`. Excludes, in order:
 *  - cards in a different project
 *  - the card itself (no self-block)
 *  - archived cards
 *  - cards already in a done column (a done task can't block)
 *  - cards already listed as blockers
 */
export function computeCandidateBlockers(
  cards: TaskCard[],
  card: Pick<TaskCard, "id" | "projectId" | "blockedByIds">,
  doneColumnIds: Set<string>,
): TaskCard[] {
  const existingBlockers = card.blockedByIds ?? [];
  return cards.filter(
    (c) =>
      c.projectId === card.projectId &&
      c.id !== card.id &&
      !c.archivedAt &&
      !doneColumnIds.has(c.columnId) &&
      !existingBlockers.includes(c.id),
  );
}
