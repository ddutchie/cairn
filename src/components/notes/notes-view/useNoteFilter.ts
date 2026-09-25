"use client";

/**
 * useNoteFilter — filters notes by text search and active tag.
 *
 * Titles (and any bodies already in memory) match synchronously. Note bodies
 * load lazily in Electron, so body matches come from the main process
 * (`window.electron.note.search`, debounced) and are merged in when they
 * arrive — the list never waits on IPC to show title matches.
 */

import { useEffect, useMemo, useState } from "react";
import type { Note } from "@/types";
import { matchesQuery } from "../../../../shared/notes/text";
import { noteSearchText } from "@/lib/note-text";

const BODY_SEARCH_DEBOUNCE_MS = 120;

export function useNoteFilter(
  notes: Note[],
  filter: string,
  activeTagId: string | null,
  projectId?: string | null,
): Note[] {
  const [bodyMatches, setBodyMatches] = useState<{ query: string; ids: Set<string> } | null>(null);
  const query = filter.trim();

  useEffect(() => {
    const searchNotes = typeof window !== "undefined" ? window.electron?.note?.search : undefined;
    if (!query || !searchNotes) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const ids = await searchNotes(query, projectId ?? undefined);
        if (!cancelled) setBodyMatches({ query, ids: new Set(ids) });
      } catch { /* title matches still apply */ }
    }, BODY_SEARCH_DEBOUNCE_MS);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [query, projectId]);

  return useMemo(() => {
    const ids = bodyMatches?.query === query ? bodyMatches.ids : null;
    return notes.filter((n) => {
      // Empty filter matches all; otherwise every query term must appear in the
      // title or body (AND-of-terms), so "meeting notes" matches a note titled
      // "Notes from the meeting" — not just the literal phrase.
      const matchesText = !query || !!ids?.has(n.id) || matchesQuery(filter, noteSearchText(n));
      const matchesTag = !activeTagId || n.tagIds.includes(activeTagId);
      return matchesText && matchesTag;
    });
  }, [notes, filter, query, activeTagId, bodyMatches]);
}
