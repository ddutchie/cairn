/**
 * Legacy dashboard conversion.
 *
 * Dashboards (notes with type='dashboard' holding a self-contained HTML page)
 * were removed in 3.1.3. Rather than dropping users' data, every live dashboard
 * row is rewritten as a regular markdown note: a short explanation followed by
 * the original HTML in a fenced ```html block. The note then behaves like any
 * other (gets a .md file, syncs to the phone, can be deleted by the user).
 *
 * Runs at boot (see splash/boot-sequence.ts) rather than as a schema migration
 * because the .md file has to be written too, and so that a dashboard synced in
 * later from a peer still on an older Cairn is converted on the next start.
 * Tombstoned rows are left alone — they never show, and touching them would
 * re-stage a sync delete. The row mapper treats any leftover type='dashboard'
 * as a plain note.
 */
import type Database from "better-sqlite3";
import { updateNote } from "./notes-queries";

/** Wrap a dashboard's HTML in a markdown note body. Pure; exported for tests. */
export function dashboardToMarkdown(html: string): string {
  const body = html.trim();
  // The fence must be longer than any backtick run inside the HTML.
  const longestRun = Math.max(0, ...(body.match(/`+/g) ?? []).map((r) => r.length));
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  const intro =
    "> This was a Cairn dashboard. Dashboards were removed in Cairn 3.1.3, so its HTML is kept below. " +
    "To view it, save the code block as an `.html` file and open it in a browser. " +
    "Live `window.cairn` data calls no longer work.";
  return body ? `${intro}\n\n${fence}html\n${body}\n${fence}\n` : `${intro}\n`;
}

/**
 * Convert every live (non-tombstoned) type='dashboard' row to a markdown note.
 * Returns the converted notes so the caller can write their .md files.
 */
export function convertLegacyDashboards(db: Database.Database): ReturnType<typeof updateNote>[] {
  const rows = db
    .prepare("SELECT id, content FROM notes WHERE type = 'dashboard' AND deleted_at IS NULL")
    .all() as { id: string; content: string | null }[];
  if (rows.length === 0) return [];
  return db.transaction(() =>
    rows.map((r) => updateNote(db, r.id, { type: "note", content: dashboardToMarkdown(r.content ?? "") })),
  )();
}
