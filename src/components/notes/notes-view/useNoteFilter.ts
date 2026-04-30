"use client";

/**
 * useNoteFilter — filters notes by text search and active tag.
 */

import type { Note } from "@/types";

export function useNoteFilter(
  notes: Note[],
  filter: string,
  activeTagId: string | null,
): Note[] {
  return notes.filter((n) => {
    const matchesText =
      !filter ||
      n.title.toLowerCase().includes(filter.toLowerCase()) ||
      n.contentText.toLowerCase().includes(filter.toLowerCase());
    const matchesTag = !activeTagId || n.tagIds.includes(activeTagId);
    return matchesText && matchesTag;
  });
}
