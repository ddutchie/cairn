"use client";

/**
 * useNoteFilter — filters notes by text search and active tag.
 * Uses useMemo so the filter is only recomputed when inputs change.
 */

import { useMemo } from "react";
import type { Note } from "@/types";
import { matchesQuery } from "../../../../shared/notes/text";

export function useNoteFilter(
  notes: Note[],
  filter: string,
  activeTagId: string | null,
): Note[] {
  return useMemo(() => {
    return notes.filter((n) => {
      // Empty filter matches all; otherwise every query term must appear in the
      // title or body (AND-of-terms), so "meeting notes" matches a note titled
      // "Notes from the meeting" — not just the literal phrase.
      const matchesText = !filter.trim() || matchesQuery(filter, `${n.title}\n${n.contentText}`);
      const matchesTag = !activeTagId || n.tagIds.includes(activeTagId);
      return matchesText && matchesTag;
    });
  }, [notes, filter, activeTagId]);
}
