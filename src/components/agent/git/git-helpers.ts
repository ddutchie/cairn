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
  // Staged ("D ") or unstaged (" D") deletions both map to danger.
  if (s.startsWith("D") || s === " D") return "var(--danger)";
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

export function areFileListsEqual(
  a: GitFileEntry[],
  b: GitFileEntry[]
): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].path !== b[i].path || a[i].status !== b[i].status) return false;
  }
  return true;
}

export function areGitStatusesEqual(
  a: GitStatusData | null,
  b: GitStatusData | null
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (
    a.branch !== b.branch ||
    a.ahead !== b.ahead ||
    a.behind !== b.behind ||
    a.hasUpstream !== b.hasUpstream ||
    a.defaultBranch !== b.defaultBranch
  ) {
    return false;
  }
  return (
    areFileListsEqual(a.staged, b.staged) &&
    areFileListsEqual(a.unstaged, b.unstaged) &&
    areFileListsEqual(a.untracked, b.untracked)
  );
}

export function areBranchesEqual(
  a: Array<{ name: string; current: boolean }>,
  b: Array<{ name: string; current: boolean }>
): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].name !== b[i].name || a[i].current !== b[i].current) return false;
  }
  return true;
}

export function areLogEntriesEqual(
  a: GitLogData,
  b: GitLogData
): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (
      a[i].hash !== b[i].hash ||
      a[i].subject !== b[i].subject ||
      a[i].author !== b[i].author ||
      a[i].date !== b[i].date
    ) {
      return false;
    }
  }
  return true;
}

export function arePrStatusesEqual(
  a: { url: string | null; state: string | null; title: string | null } | null,
  b: { url: string | null; state: string | null; title: string | null } | null
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.url === b.url && a.state === b.state && a.title === b.title;
}
