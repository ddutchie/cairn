/**
 * Renderer-side note text helpers.
 *
 * `Note.contentText` is a short preview excerpt (see shared/notes/excerpt.ts),
 * so full-text search derives the plain text from `content` on demand. The
 * result is cached per note object: the store keeps object identity for
 * unchanged notes across refreshes (reconcileById), so each body is stripped at
 * most once until it actually changes — and only if the user searches.
 */

import type { Note } from "@/types";
import { stripMarkdown } from "@/components/notes/note-editor-utils";
import { noteExcerpt } from "../../shared/notes/excerpt";

/** Preview excerpt for a note body (what `contentText` should hold). */
export function excerptFor(content: string, type: Note["type"] = "note"): string {
  return noteExcerpt(content, type, stripMarkdown);
}

const searchTextCache = new WeakMap<Note, string>();

/** `title + plain-text body` for matching a search query (dashboards: title only). */
export function noteSearchText(note: Note): string {
  let text = searchTextCache.get(note);
  if (text === undefined) {
    const body = note.type === "dashboard" ? "" : stripMarkdown(note.content ?? "");
    text = `${note.title}\n${body}`;
    searchTextCache.set(note, text);
  }
  return text;
}
