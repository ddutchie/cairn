import type { TaskCard, BoardColumn } from "@/types";

/**
 * Pure drag-and-drop interaction logic for the Kanban board, extracted from
 * board.tsx so the reorder/move math and destructive-zone hit-testing can be
 * unit-tested without React-DnD or the store.
 */

/**
 * Hit-test a pointer against the archive / delete drop zones in the action bar.
 * Returns the zone the pointer is over, or null if outside the bar entirely.
 *
 * The pointer must be vertically within the bar; then archive takes precedence
 * over delete (matching their left-to-right layout).
 */
export function getZoneHit(
  clientX: number,
  clientY: number,
  barRect: DOMRect | null,
  archiveRect: DOMRect | null,
  deleteRect: DOMRect | null,
): "archive" | "delete" | null {
  if (!barRect) return null;
  if (clientY < barRect.top || clientY > barRect.bottom) return null;
  if (archiveRect && clientX >= archiveRect.left && clientX <= archiveRect.right) return "archive";
  if (deleteRect && clientX >= deleteRect.left && clientX <= deleteRect.right) return "delete";
  return null;
}

/**
 * Resolve where a dragged card should land given the drop target id (`overId`).
 *
 * Two cases:
 *  - Dropping onto a column → append to the end of that column.
 *  - Dropping onto a card → insert at that card's index within its column
 *    (the dragged card is excluded first so the index isn't skewed by its own
 *    presence — the classic same-column reorder off-by-one).
 *
 * Returns `null` for invalid targets or no-op moves (dropping a card back onto
 * its own current slot), so callers can short-circuit without mutating state.
 */
export function resolveCardDrop(
  columns: BoardColumn[],
  getColumnCards: (columnId: string) => TaskCard[],
  draggedCard: TaskCard,
  overId: string,
): { targetColumnId: string; targetIndex: number } | null {
  let targetColumnId: string;
  let targetIndex: number;

  const isOverColumn = columns.some((c) => c.id === overId);
  if (isOverColumn) {
    targetColumnId = overId;
    targetIndex = getColumnCards(overId).length;
  } else {
    const overCard = columns
      .flatMap((c) => getColumnCards(c.id).map((card) => ({ id: card.id, colId: c.id })))
      .find((c) => c.id === overId);
    if (!overCard) return null;
    targetColumnId = overCard.colId;
    const colCards = getColumnCards(targetColumnId).filter((c) => c.id !== draggedCard.id);
    const overIdx = colCards.findIndex((c) => c.id === overId);
    targetIndex = overIdx >= 0 ? overIdx : colCards.length;
  }

  // No-op: the card is already occupying the resolved slot.
  //  - Card-target drop: the resolved index already holds the dragged card.
  //  - Column-body drop (append to end): the dragged card is already the last
  //    card of the same column, so appending wouldn't move it. The card-target
  //    guard below can't catch this because targetIndex == length (one past the
  //    end), where the lookup is always undefined.
  const sameColumn = draggedCard.columnId === targetColumnId;
  if (sameColumn && isOverColumn) {
    const colCards = getColumnCards(targetColumnId);
    if (colCards[colCards.length - 1]?.id === draggedCard.id) {
      return null;
    }
  }
  if (
    sameColumn &&
    getColumnCards(targetColumnId)[targetIndex]?.id === draggedCard.id
  ) {
    return null;
  }

  return { targetColumnId, targetIndex };
}
