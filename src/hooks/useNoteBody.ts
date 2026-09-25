"use client";

/**
 * useNoteBody — make sure a note's body is loaded (Electron loads bodies
 * lazily, see store/note-bodies.ts) and keep it pinned in the body cache while
 * the caller is mounted. Returns the body (undefined while loading) and whether
 * it is available. In the web build bodies are always present.
 */

import { useEffect } from "react";
import { useCairnStore } from "@/store";
import { pinNoteBody, unpinNoteBody } from "@/store/note-bodies";

export function useNoteBody(noteId: string | null | undefined): { content: string | undefined; loaded: boolean } {
  const content = useCairnStore((s) => (noteId ? s.notes.find((n) => n.id === noteId)?.content : undefined));
  const ensureNoteBodies = useCairnStore((s) => s.ensureNoteBodies);

  useEffect(() => {
    if (!noteId) return;
    pinNoteBody(noteId);
    void ensureNoteBodies([noteId]);
    return () => unpinNoteBody(noteId);
  }, [noteId, ensureNoteBodies]);

  return { content, loaded: content !== undefined };
}
