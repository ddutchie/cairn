"use client";

/**
 * useNoteBody — make sure a note's body is loaded (Electron loads bodies
 * lazily, see store/note-bodies.ts) and keep it pinned in the body cache while
 * the caller is mounted. Returns the body (undefined while loading), whether it
 * is available, whether the last load attempt failed, and a retry action. In
 * the web build bodies are always present.
 */

import { useCallback, useEffect, useState } from "react";
import { useCairnStore } from "@/store";
import { pinNoteBody, unpinNoteBody } from "@/store/note-bodies";

export function useNoteBody(noteId: string | null | undefined): {
  content: string | undefined;
  loaded: boolean;
  failed: boolean;
  retry: () => void;
} {
  const content = useCairnStore((s) => (noteId ? s.notes.find((n) => n.id === noteId)?.content : undefined));
  const ensureNoteBodies = useCairnStore((s) => s.ensureNoteBodies);
  const [attempt, setAttempt] = useState(0);
  // Key of the (note, attempt) whose load failed — derived, so switching notes
  // or retrying clears the failure without a state reset inside the effect.
  const [failedKey, setFailedKey] = useState<string | null>(null);
  const key = `${noteId ?? ""}:${attempt}`;

  useEffect(() => {
    if (!noteId) return;
    pinNoteBody(noteId);
    let cancelled = false;
    void ensureNoteBodies([noteId]).then(() => {
      if (cancelled) return;
      // ensureNoteBodies swallows IPC errors; a live note still without a
      // body afterwards means the load failed.
      const note = useCairnStore.getState().notes.find((n) => n.id === noteId);
      if (note && note.content === undefined) setFailedKey(`${noteId}:${attempt}`);
    });
    return () => {
      cancelled = true;
      unpinNoteBody(noteId);
    };
  }, [noteId, attempt, ensureNoteBodies]);

  const retry = useCallback(() => setAttempt((a) => a + 1), []);
  const loaded = content !== undefined;
  return { content, loaded, failed: !loaded && failedKey === key, retry };
}
