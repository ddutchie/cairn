/**
 * Types + pure helpers for the Agent GitView, extracted so the file-row / diff
 * sub-components can share them without the monolithic parent. No React here —
 * the status-mapping helpers are unit-testable in isolation.
 */

// Inline types matching the preload's ElectronAPI git return shapes.
export interface GitFileEntry {
  path: string;
  status: string;
}
export interface GitStatusData {
  branch: string;
  ahead: string;
  behind: string;
  hasUpstream: boolean;
  defaultBranch: string;
  staged: GitFileEntry[];
  unstaged: GitFileEntry[];
  untracked: GitFileEntry[];
}
export type GitLogData = Array<{
  hash: string;
  author: string;
  date: string;
  subject: string;
}>;

/** Human-readable label for a git two-char status code. */
export function statusLabel(s: string): string {
  if (s === "??") return "untracked";
  if (s === "M ") return "modified";
  if (s === "A ") return "added";
  if (s === "D ") return "deleted";
  if (s === "R ") return "renamed";
  if (s === " M") return "modified";
  if (s === " D") return "deleted";
  return s.trim() || "changed";
}

/** CSS-variable colour for a git status code (added/deleted/renamed/untracked). */
export function statusColor(s: string): string {
  if (s.startsWith("A")) return "var(--success)";
  if (s.startsWith("D")) return "var(--danger)";
  if (s.startsWith("R")) return "var(--accent)";
  if (s.startsWith("?")) return "var(--text-tertiary)";
  return "var(--warning)";
}

/**
 * A file can appear in BOTH staged and unstaged sections (e.g. status "MM").
 * Key diffs/expanded/loading state by section+path so the two sections don't
 * clobber each other's state.
 */
export function diffKey(path: string, staged: boolean): string {
  return `${staged ? "s" : "u"}:${path}`;
}
