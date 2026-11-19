/**
 * Persona notes (People layer) stay out of the regular Notes list and note
 * pickers while `feature.people` is on; the person page is their home. A
 * "Show people's notes" toggle in the Notes view brings them back. With the
 * flag off nothing is hidden.
 */

import { useMemo } from "react";
import { useCairnStore } from "@/store";
import { useShallow } from "zustand/react/shallow";

const NONE: ReadonlySet<string> = new Set();

/** The note ids to leave out of lists and pickers right now (empty when the flag is off or the toggle is on). */
export function hiddenPersonaIds(
  s: { peopleEnabled: boolean; showPersonaNotes: boolean; personaNoteIds: readonly string[] },
): ReadonlySet<string> {
  if (!s.peopleEnabled || s.showPersonaNotes || s.personaNoteIds.length === 0) return NONE;
  return new Set(s.personaNoteIds);
}

/** Drop persona notes from a list of notes. Returns the same array when nothing is hidden. */
export function withoutPersonaNotes<T extends { id: string }>(notes: T[], hidden: ReadonlySet<string>): T[] {
  return hidden.size === 0 ? notes : notes.filter((n) => !hidden.has(n.id));
}

/** Hook form of {@link hiddenPersonaIds}, stable between renders while the inputs are unchanged. */
export function useHiddenPersonaIds(): ReadonlySet<string> {
  const { peopleEnabled, showPersonaNotes, personaNoteIds } = useCairnStore(useShallow((s) => ({
    peopleEnabled: s.peopleEnabled, showPersonaNotes: s.showPersonaNotes, personaNoteIds: s.personaNoteIds,
  })));
  return useMemo(() => hiddenPersonaIds({ peopleEnabled, showPersonaNotes, personaNoteIds }), [peopleEnabled, showPersonaNotes, personaNoteIds]);
}
