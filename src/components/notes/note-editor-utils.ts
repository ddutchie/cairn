/** Pure helpers for the note editor. */

export function countWords(md: string): number {
  const text = md
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`[^`]*`/g, "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[*_~]/g, "")
    .replace(/!\[[^\]]*\]\([^)]+\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "")
    .trim();
  if (!text) return 0;
  return text.split(/\s+/).filter(Boolean).length;
}

/**
 * Toggle the Nth task-list checkbox in raw markdown source.
 *
 * The implementation now lives in `shared/notes/markdown.ts` so the mobile
 * renderer shares the exact same source-toggle logic. Re-exported here to keep
 * the desktop import site (`./note-editor-utils`) stable. Handles both list
 * markers (`- [ ]`) and GFM table-cell checkboxes.
 */
export { toggleCheckboxInSource } from "../../../shared/notes/markdown";

export function stripMarkdown(md: string): string {
  return md
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/`{1,3}[^`]*`{1,3}/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^[-*+]\s+/gm, "")
    .replace(/^\d+\.\s+/gm, "")
    .replace(/^>\s+/gm, "")
    .replace(/^---+$/gm, "")
    .replace(/\|/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();
}
