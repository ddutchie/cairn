/**
 * Helpers behind the Git panel's actions (no React).
 */
import type { ProjectSettings } from "@/types";
import type { GitStatusData } from "./git-helpers";

/** Confirmation text for discarding `paths`, matched to what the discard will do. */
export function discardMessage(status: GitStatusData | null, paths: string[]): string {
  if (paths.length === 1) {
    const p = paths[0];
    const isStaged = status?.staged.some((f) => f.path === p);
    const isUnstaged = status?.unstaged.some((f) => f.path === p);
    const isUntracked = status?.untracked.some((f) => f.path === p);

    if (isUntracked) {
      return `Delete the untracked file ${p}? This cannot be undone.`;
    } else if (isStaged && isUnstaged) {
      return `Discard unstaged changes in ${p}? Staged changes will be preserved.`;
    } else if (isStaged) {
      return `Discard staged changes in ${p}? This will revert the file to its HEAD state.`;
    } else {
      return `Discard changes in ${p}? This cannot be undone.`;
    }
  } else {
    const containsUntracked = paths.some(p => status?.untracked.some(f => f.path === p));
    const containsStaged = paths.some(p => status?.staged.some(f => f.path === p));
    const containsUnstaged = paths.some(p => status?.unstaged.some(f => f.path === p));

    if (containsUntracked && !containsStaged && !containsUnstaged) {
      return `Delete these ${paths.length} untracked files? This cannot be undone.`;
    } else if (containsStaged && containsUnstaged) {
      return `Discard unstaged changes in these ${paths.length} files? Staged changes in partially staged files will be preserved.`;
    } else {
      return `Discard changes in these ${paths.length} files? This cannot be undone.`;
    }
  }
}

/**
 * The PR description template to send to the model: the repository's
 * `.github/PULL_REQUEST_TEMPLATE.md` when the project prefers it or has no
 * custom template, otherwise the project's own template. "" when none.
 */
export async function readPrTemplate(cwd: string, settings: ProjectSettings | undefined): Promise<string> {
  const custom = settings?.useRepoPrTemplate ? "" : settings?.prTemplate || "";
  if (custom || !window.electron?.agent) return custom;
  const sep = window.electron.platform === "win32" ? "\\" : "/";
  try {
    return await window.electron.agent.readFile(`${cwd}${sep}.github${sep}PULL_REQUEST_TEMPLATE.md`);
  } catch {
    return "";
  }
}
