/**
 * Automation folder plumbing — the filesystem home of an automation's "mini-app".
 *
 * Layout (per project, or the workspace root for workspace-scoped automations):
 *   <project>/            (or <workspace>/)
 *     .automations/<automationId>/
 *       .env              (env vars, materialized before runs — phase 3)
 *       manifest.json     (self-describing spec — phase 3)
 *       scripts/          (authored scripts — phase 2)
 *       runs/<runId>/     (per-run working dir — cwd for run_script, phase 2)
 *
 * The root is dot-prefixed so the notes browser, the file-watcher, and Obsidian
 * vaults all skip it (every one of them filters dot-entries) — the mini-app is
 * invisible to the app's note surface by construction.
 *
 * All helpers are pure path/fs operations, imported by the heartbeat runner
 * and covered by unit tests. Best-effort by design: a filesystem failure must
 * never fail a background automation run, so callers wrap folder I/O in
 * try/catch.
 */

import fs from "fs";
import path from "path";
import { toSlug } from "../shared/text-utils";

export const AUTOMATION_FOLDER_NAME = ".automations";
export const RUNS_FOLDER_NAME = "runs";
export const SCRIPTS_FOLDER_NAME = "scripts";

/** Default number of completed per-run folders to keep before pruning. */
export const KEEP_RUN_DIRS = 10;

/** `<workspace>/<slug(projectName)>/` — the project's notes root on disk. */
export function projectRootDir(workspacePath: string, projectName: string): string {
  return path.join(workspacePath, toSlug(projectName));
}

/**
 * The automation's home folder:
 *   project-scoped   → <project>/.automations/<automationId>/
 *   workspace-scoped → <workspace>/.automations/<automationId>/
 */
export function automationFolderDir(
  workspacePath: string,
  automationId: string,
  projectName?: string | null,
): string {
  const parent = projectName ? projectRootDir(workspacePath, projectName) : workspacePath;
  return path.join(parent, AUTOMATION_FOLDER_NAME, automationId);
}

/** `<automation folder>/scripts/` — where authored scripts live (phase 2). */
export function automationScriptsDir(automationDir: string): string {
  return path.join(automationDir, SCRIPTS_FOLDER_NAME);
}

/** `<automation folder>/runs/<runId>/` — the per-run working directory. */
export function automationRunDir(automationDir: string, runId: string): string {
  return path.join(automationDir, RUNS_FOLDER_NAME, runId);
}

/** Create the automation root (and scripts dir) if missing. Returns the root. */
export function ensureAutomationDir(automationDir: string): string {
  fs.mkdirSync(automationDir, { recursive: true });
  fs.mkdirSync(automationScriptsDir(automationDir), { recursive: true });
  return automationDir;
}

/** Create the run's working directory (and parents) and return its path. */
export function ensureAutomationRunDir(automationDir: string, runId: string): string {
  const dir = automationRunDir(automationDir, runId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Prune old per-run folders, keeping the `keep` most recent by mtime. Only
 * directories directly inside `runs/` are ever touched — files are left alone.
 * Returns the number of folders removed.
 */
export function cleanupOldRunDirs(automationDir: string, keep: number = KEEP_RUN_DIRS): number {
  const runsDir = path.join(automationDir, RUNS_FOLDER_NAME);
  if (!fs.existsSync(runsDir)) return 0;
  let dirs: string[];
  try {
    dirs = fs.readdirSync(runsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => path.join(runsDir, e.name))
      .sort((a, b) => {
        try {
          return fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs;
        } catch {
          return 0;
        }
      });
  } catch {
    return 0;
  }
  const excess = Math.max(0, dirs.length - keep);
  for (let i = 0; i < excess; i++) {
    try { fs.rmSync(dirs[i], { recursive: true, force: true }); } catch { /* best-effort */ }
  }
  return excess;
}
