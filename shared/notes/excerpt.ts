/**
 * Note `contentText` is a short plain-text EXCERPT (for list/overview/table
 * previews), not a full plain-text mirror of the body.
 *
 * Shipping a full stripped copy of every note alongside its markdown doubled
 * the renderer snapshot (≈45% of the IPC payload) and stripping every body
 * dominated snapshot build time on the Electron main thread (~330ms at 10k
 * notes). Previews only ever show ≤120 chars; full-text search derives the
 * plain text on demand instead (renderer: `noteSearchText`, MCP search: from
 * `content`).
 */

/** Longest preview any UI shows is 120 chars; keep a little headroom. */
export const NOTE_EXCERPT_CHARS = 200;
/** Markdown prefix stripped to produce the excerpt (markup shrinks when stripped). */
export const EXCERPT_SOURCE_CHARS = 600;

export function noteExcerpt(
  content: string | null | undefined,
  type: string | null | undefined,
  strip: (md: string) => string,
): string {
  if (!content || type === "dashboard") return "";
  return strip(content.slice(0, EXCERPT_SOURCE_CHARS)).slice(0, NOTE_EXCERPT_CHARS);
}
