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
export const OUT_FOLDER_NAME = "out";

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

/** `<automation folder>/scripts/` — where authored scripts live. */
export function automationScriptsDir(automationDir: string): string {
  return path.join(automationDir, SCRIPTS_FOLDER_NAME);
}

/** `<automation folder>/out/` — durable deliverables, never pruned. */
export function automationOutDir(automationDir: string): string {
  return path.join(automationDir, OUT_FOLDER_NAME);
}

/** `<automation folder>/.env` — non-secret env vars (secrets never hit disk). */
export function automationEnvFilePath(automationDir: string): string {
  return path.join(automationDir, ".env");
}

/** `<automation folder>/manifest.json` — the automation's self-describing spec. */
export function automationManifestPath(automationDir: string): string {
  return path.join(automationDir, "manifest.json");
}

/** `<automation folder>/runs/<runId>/` — the per-run working directory. */
export function automationRunDir(automationDir: string, runId: string): string {
  return path.join(automationDir, RUNS_FOLDER_NAME, runId);
}

/** Create the automation root (plus scripts/ + out/) if missing. Returns the root. */
export function ensureAutomationDir(automationDir: string): string {
  fs.mkdirSync(automationDir, { recursive: true });
  fs.mkdirSync(automationScriptsDir(automationDir), { recursive: true });
  fs.mkdirSync(automationOutDir(automationDir), { recursive: true });
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

// ── File listing (Develop modal) ─────────────────────────────────────────────

export interface AutomationFolderFile {
  /** Path relative to the automation folder, posix separators. */
  path: string;
  size: number;
  mtimeMs: number;
}

const MAX_TREE_DEPTH = 4;

/**
 * Recursively list the automation folder's files (scripts/, manifest.json,
 * .env, out/) with sizes + mtimes — so the Develop modal can show what the
 * agent is changing. Per-run `runs/` scratch is skipped (it's ephemeral and
 * can be large). Best-effort: unreadable entries are skipped.
 */
export function listAutomationFolderFiles(automationDir: string): AutomationFolderFile[] {
  const out: AutomationFolderFile[] = [];
  const walk = (dir: string, rel: string, depth: number) => {
    if (depth > MAX_TREE_DEPTH) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === RUNS_FOLDER_NAME) continue;
      const full = path.join(dir, e.name);
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        walk(full, relPath, depth + 1);
      } else if (e.isFile()) {
        try {
          const st = fs.statSync(full);
          out.push({ path: relPath, size: st.size, mtimeMs: st.mtimeMs });
        } catch { /* best-effort */ }
      }
    }
  };
  walk(automationDir, "", 0);
  return out;
}
