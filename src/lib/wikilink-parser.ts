/**
 * Wikilink parser — `[[Note Title]]` syntax helpers
 *
 * Used by:
 *  - The note editor autocomplete (detects `[[` trigger)
 *  - The note renderer (renders wikilinks as clickable spans)
 *  - The graph engine (electron/db/graph-queries.ts has its own inline copy
 *    for the Node/Electron ABI boundary — keep in sync with WIKILINK_RE)
 */

/** Matches `[[Title]]` — capture group 1 is the title (trimmed) */
export const WIKILINK_RE = /\[\[([^\][\n]+?)\]\]/g;

export interface WikilinkMatch {
  /** Full raw match including brackets, e.g. `[[My Note]]` */
  raw: string;
  /** Inner title text, trimmed */
  title: string;
  /** Start index (character offset in the source string) */
  index: number;
  /** End index (exclusive) */
  end: number;
}

/**
 * Extract all `[[Title]]` wikilinks from a markdown string.
 * Returns matches in source order.
 */
export function parseWikilinks(content: string): WikilinkMatch[] {
  const results: WikilinkMatch[] = [];
  const re = new RegExp(WIKILINK_RE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const title = m[1].trim();
    if (title.length === 0) continue;
    results.push({
      raw: m[0],
      title,
      index: m.index,
      end: m.index + m[0].length,
    });
  }
  return results;
}

export interface ResolvedWikilink extends WikilinkMatch {
  /** Resolved note ID, or null if no note with this title exists */
  noteId: string | null;
}

/**
 * Resolve wikilink titles to note IDs.
 *
 * Matching is exact, case-insensitive. If multiple notes share the same
 * title the first one wins (insertion order of the `notes` array).
 */
export function resolveWikilinks(
  content: string,
  notes: { id: string; title: string }[]
): ResolvedWikilink[] {
  // Build a lowercase-title → id lookup (first match wins)
  const titleIndex = new Map<string, string>();
  for (const n of notes) {
    const key = n.title.toLowerCase().trim();
    if (!titleIndex.has(key)) titleIndex.set(key, n.id);
  }

  return parseWikilinks(content).map((wl) => ({
    ...wl,
    noteId: titleIndex.get(wl.title.toLowerCase()) ?? null,
  }));
}

/**
 * Split `content` into an array of plain-text and wikilink segments,
 * useful for rendering wikilinks inline without a full markdown parser.
 *
 * Example output for `"Hello [[World]] foo"`:
 * ```
 * [
 *   { type: "text",     text: "Hello " },
 *   { type: "wikilink", text: "World", noteId: "abc123" | null },
 *   { type: "text",     text: " foo" },
 * ]
 * ```
 */
export type ContentSegment =
  | { type: "text"; text: string }
  | { type: "wikilink"; text: string; noteId: string | null };

export function segmentContent(
  content: string,
  notes: { id: string; title: string }[]
): ContentSegment[] {
  const resolved = resolveWikilinks(content, notes);
  if (resolved.length === 0) return [{ type: "text", text: content }];

  const segments: ContentSegment[] = [];
  let cursor = 0;

  for (const wl of resolved) {
    if (wl.index > cursor) {
      segments.push({ type: "text", text: content.slice(cursor, wl.index) });
    }
    segments.push({ type: "wikilink", text: wl.title, noteId: wl.noteId });
    cursor = wl.end;
  }

  if (cursor < content.length) {
    segments.push({ type: "text", text: content.slice(cursor) });
  }

  return segments;
}

/**
 * Returns the partial wikilink being typed at the cursor position, or null.
 *
 * Detects `[[` followed by any text up to the cursor without a closing `]]`.
 * Used by the editor autocomplete to know when to show the picker.
 */
export interface ActiveWikilink {
  /** The text typed so far after `[[`, e.g. `"My N"` */
  query: string;
  /** Character offset in the document where `[[` starts */
  triggerFrom: number;
}

export function getActiveWikilink(
  content: string,
  cursorPos: number
): ActiveWikilink | null {
  // Look backwards from cursor for `[[` without an intervening `]]` or newline
  const before = content.slice(0, cursorPos);
  const lastOpen = before.lastIndexOf("[[");
  if (lastOpen === -1) return null;

  const between = before.slice(lastOpen + 2);
  // If there's a closing `]]` or a newline between `[[` and cursor → not active
  if (between.includes("]]") || between.includes("\n")) return null;

  return { query: between, triggerFrom: lastOpen };
}
