/**
 * Wikilink (`[[Note Title]]`) parsing — the single source of truth for the
 * renderer, the Electron main process (backlinks, auto-relationships), the MCP
 * server and mobile. Pure, no platform deps.
 *
 * `WIKILINK_RE` is a global regex; callers that loop with `exec` should build
 * their own instance (`new RegExp(WIKILINK_RE.source, "g")`) or reset
 * `lastIndex`, since the exported object's state is shared module-wide.
 */

/** Matches `[[Title]]` — capture group 1 is the (untrimmed) title. */
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
 * Extract all `[[Title]]` wikilinks from a markdown string, in source order.
 * Empty `[[ ]]` links are skipped.
 */
export function parseWikilinks(content: string): WikilinkMatch[] {
  const results: WikilinkMatch[] = [];
  const re = new RegExp(WIKILINK_RE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const title = m[1].trim();
    if (title.length === 0) continue;
    results.push({ raw: m[0], title, index: m.index, end: m.index + m[0].length });
  }
  return results;
}

/** True when `content` contains a wikilink to `title` (case-insensitive). */
export function linksToTitle(content: string, title: string): boolean {
  const target = title.toLowerCase();
  return parseWikilinks(content).some((l) => l.title.toLowerCase() === target);
}
