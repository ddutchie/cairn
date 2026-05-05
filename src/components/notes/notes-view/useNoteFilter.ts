"use client";

/**
 * useNoteFilter — filters notes by text search and active tag.
 * Uses useMemo so the filter is only recomputed when inputs change.
 */

import { useMemo } from "react";
import type { Note } from "@/types";

export function useNoteFilter(
  notes: Note[],
  filter: string,
  activeTagId: string | null,
): Note[] {
  return useMemo(() => {
    const lowerFilter = filter.toLowerCase();
    return notes.filter((n) => {
      const matchesText =
        !filter ||
        n.title.toLowerCase().includes(lowerFilter) ||
        n.contentText.toLowerCase().includes(lowerFilter);
      const matchesTag = !activeTagId || n.tagIds.includes(activeTagId);
      return matchesText && matchesTag;
    });
  }, [notes, filter, activeTagId]);
}
