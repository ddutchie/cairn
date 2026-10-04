/** Git payloads shared by the IPC contract, the main-process handlers and the renderer. */

export interface GitStatusEntry {
  path: string;
  /** Two-letter porcelain code (e.g. "M ", " M", "??"). */
  status: string;
}

export interface GitStatus {
  branch: string;
  ahead: string;
  behind: string;
  hasUpstream: boolean;
  defaultBranch: string;
  staged: GitStatusEntry[];
  unstaged: GitStatusEntry[];
  untracked: GitStatusEntry[];
}

export interface GitBranchList {
  current: string;
  branches: Array<{ name: string; current: boolean }>;
}

export interface GitLogEntry {
  hash: string;
  author: string;
  date: string;
  subject: string;
}

export interface GitFileDiff {
  stat: { added: number; deleted: number };
  diff: string;
}

export interface GitPrStatus {
  url: string | null;
  state: string | null;
  title: string | null;
}

export type GitStashAction = "push" | "pop" | "list";

/** Stage/unstage either every change (`all`) or the listed paths. */
export interface GitPathSelection {
  files?: string[];
  all?: boolean;
}
