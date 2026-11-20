import { useCallback, useState } from "react";

/**
 * Tool cards the user opened, by call id. The transcript is virtualised and its rows
 * are rebuilt as steps arrive, so a card can unmount and mount again while a turn is
 * still running. Local state would reset and collapse a card the moment it opened;
 * this set outlives the component. Call ids are unique per call, so entries never
 * collide, and one short string per opened card is all it holds.
 */
const opened = new Set<string>();

/** Open state for an expandable tool card. With no `key` it behaves as plain local state. */
export function useOpenedCard(key: string | undefined, initial = false): [boolean, (next: boolean) => void] {
  const [open, setOpen] = useState(() => initial || (key !== undefined && opened.has(key)));
  const set = useCallback((next: boolean) => {
    if (key !== undefined) { if (next) opened.add(key); else opened.delete(key); }
    setOpen(next);
  }, [key]);
  return [open, set];
}

/** Test seam: forget every opened card. */
export function resetOpenedCards(): void {
  opened.clear();
}
