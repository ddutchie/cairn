/**
 * Pure drop-resolution for the calendar, shared by desktop (dnd-kit) and mobile
 * (reanimated gesture core), so both apps reschedule with identical rules and
 * can't drift apart.
 *
 * A drop target id is either a "yyyy-MM-dd" day key or the literal
 * "unscheduled". resolveDateDrop maps a drop onto the patch that should be
 * applied to the card (or null when the drop is a no-op, e.g. dropping a card on
 * its current day).
 */

export const UNSCHEDULED_DROP_ID = "unscheduled";

/** A "yyyy-MM-dd" key is exactly 10 chars: 4-2-2 with dashes. */
const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface DateDropResult {
  /** dueDate set to a day, or undefined to clear it. */
  dueDate: string | undefined;
}

/**
 * @param overId   the drop-target id under the pointer at drop time (or null)
 * @param card     the card being dragged (only its current dueDate matters)
 * @returns the patch to apply, or null for an invalid/no-op drop
 */
export function resolveDateDrop(
  overId: string | null | undefined,
  card: { dueDate?: string | null },
): DateDropResult | null {
  if (!overId) return null;

  if (overId === UNSCHEDULED_DROP_ID) {
    // Already unscheduled → no-op.
    if (!card.dueDate) return null;
    return { dueDate: undefined };
  }

  if (DATE_KEY_RE.test(overId)) {
    // Dropped on the day it's already due → no-op.
    if (card.dueDate === overId) return null;
    return { dueDate: overId };
  }

  // Unknown drop-target id.
  return null;
}
