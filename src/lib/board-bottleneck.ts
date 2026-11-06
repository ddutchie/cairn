/** Fewest cards in a column before calling it a bottleneck says anything useful. */
const MIN_BOTTLENECK_CARDS = 3;

export interface Bottleneck {
  name: string;
  count: number;
}

/**
 * The open column holding most of a project's open cards, or null when no column
 * stands out. A couple of cards on a new board is not a bottleneck.
 */
export function findBottleneck(
  columns: readonly { id: string; name: string; type?: string | null }[],
  cards: readonly { columnId: string }[],
): Bottleneck | null {
  const open = columns.filter((column) => column.type !== "done");
  const openIds = new Set(open.map((column) => column.id));
  const totalOpen = cards.filter((card) => openIds.has(card.columnId)).length;
  let best: Bottleneck | null = null;
  for (const column of open) {
    const count = cards.filter((card) => card.columnId === column.id).length;
    if (!best || count > best.count) best = { name: column.name, count };
  }
  if (!best || best.count < MIN_BOTTLENECK_CARDS || best.count * 2 <= totalOpen) return null;
  return best;
}
