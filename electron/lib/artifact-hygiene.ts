/**
 * artifact-hygiene — keep agent-generated files out of sight and self-limiting.
 *
 * Community plugins write artifacts into the workspace through ctx.fs
 * (dsh-visualize renders cards to `viz/<slug>-<hash>.html`). The chat fs chain
 * remaps those under `<workspace>/.chat/` (see cordis-coding-tools.ts), so this
 * module handles the rest of the lifecycle:
 *   - migrate: move a legacy top-level `viz/` (pre-remap runs) into `.chat/`,
 *   - git: list `.chat/` (+ legacy `viz/`) in `.git/info/exclude` — local-only,
 *     never touches the user's .gitignore or any tracked file,
 *   - retention: cap `.chat/viz` to the newest KEEP_ARTIFACTS files so years of
 *     visualizations don't accumulate as junk.
 */
import * as fs from "fs";
import * as path from "path";

/** Hidden dir chat artifacts live under (relative to the workspace root). */
export const CHAT_DIR = ".chat";

/** Cap for rendered artifacts per subdir — newest survive, older are pruned. */
export const KEEP_ARTIFACTS = 100;

/**
 * Move a legacy top-level `viz/` into `.chat/viz/` (first run after the remap
 * existed). Only when the source exists and the target does not — we never
 * merge or overwrite.
 */
export function migrateLegacyVizDir(root: string): boolean {
  const src = path.join(root, "viz");
  const dest = path.join(root, CHAT_DIR, "viz");
  try {
    if (!fs.existsSync(src) || fs.existsSync(dest)) return false;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(src, dest);
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensure `.git/info/exclude` lists the artifact dirs (local ignore — does not
 * touch .gitignore or any tracked file). Idempotent. Returns whether the file
 * gained lines.
 */
export function ensureGitExcluded(root: string, entries: string[] = [`${CHAT_DIR}/`, "viz/"]): boolean {
  const gitDir = path.join(root, ".git");
  if (!fs.existsSync(gitDir)) return false;
  const excludePath = path.join(gitDir, "info", "exclude");
  try {
    fs.mkdirSync(path.dirname(excludePath), { recursive: true });
    const existing = fs.existsSync(excludePath) ? fs.readFileSync(excludePath, "utf8") : "";
    const missing = entries.filter((e) => !existing.split(/\r?\n/).includes(e));
    if (missing.length === 0) return false;
    const header = existing.endsWith("\n") || existing === "" ? "" : "\n";
    fs.writeFileSync(excludePath, `${existing}${header}# cairn agent artifacts\n${missing.join("\n")}\n`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Prune `<root>/.chat/<sub>` to the newest `keep` files by mtime (subdirs like
 * `viz`). Returns the number removed. Never touches directories inside.
 */
export function pruneChatArtifacts(root: string, sub: string, keep: number = KEEP_ARTIFACTS): number {
  const dir = path.join(root, CHAT_DIR, sub);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  const files = entries.filter((e) => e.isFile()).map((e) => path.join(dir, e.name));
  if (files.length <= keep) return 0;
  const byOldFirst = files
    .map((p) => ({ p, m: (() => { try { return fs.statSync(p).mtimeMs; } catch { return 0; } })() }))
    .sort((a, b) => a.m - b.m);
  let removed = 0;
  for (const { p } of byOldFirst.slice(0, files.length - keep)) {
    try { fs.rmSync(p, { force: true }); removed++; } catch { /* ignore */ }
  }
  return removed;
}

// ── dsh session-log retention ────────────────────────────────────────────────
// The Cordis runtime persists every chat + coding turn to a JSONL session log
// under `<userData>/sessions/<encoded-cwd>/<sessionId>/session.jsonl.zstd`.
// Nothing else prunes those, so a heavy user (~20 sessions/day) accumulates
// GBs per year with no ceiling. Age-based sweep runs at boot and periodically
// thereafter — safe because sessions are read-back-only (chat/agent panes
// fold them on demand); deleting an old session removes it from the sidebar
// on next refresh, no dangling references.
//
// Default budget: 90 days. Overridable via CAIRN_SESSION_MAX_AGE_DAYS env var
// (mostly for the tests that live under artifact-hygiene.test.ts).

/** Default age (days) after which a session log is deleted. */
export const DEFAULT_SESSION_MAX_AGE_DAYS = 90;

/** Absolute floor — a session younger than this is NEVER pruned, even if the
 *  env override tries to set the budget to 0 or negative. Prevents an
 *  accidentally-set CAIRN_SESSION_MAX_AGE_DAYS=0 from wiping active runs. */
const MIN_SESSION_MAX_AGE_DAYS = 1;

export interface SessionSweepResult {
  scanned: number;
  removed: number;
  bytesFreed: number;
  cutoffMs: number;
}

function resolveMaxAgeDays(explicit?: number): number {
  if (typeof explicit === "number" && Number.isFinite(explicit)) {
    return Math.max(MIN_SESSION_MAX_AGE_DAYS, explicit);
  }
  const env = Number(process.env.CAIRN_SESSION_MAX_AGE_DAYS);
  if (Number.isFinite(env) && env > 0) {
    return Math.max(MIN_SESSION_MAX_AGE_DAYS, env);
  }
  return DEFAULT_SESSION_MAX_AGE_DAYS;
}

function dirSizeBytes(dir: string): number {
  let total = 0;
  try {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      try {
        if (ent.isDirectory()) total += dirSizeBytes(p);
        else if (ent.isFile()) total += fs.statSync(p).size;
      } catch { /* ignore per-file */ }
    }
  } catch { /* dir unreadable */ }
  return total;
}

/**
 * Sweep the dsh session root for session dirs whose mtime is older than
 * `maxAgeDays`. Session layout: `<sessionRoot>/<encoded-cwd>/<sessionId>/`
 * — we recurse ONE level (the encoded-cwd projects) and inspect each
 * session dir's mtime. Empty encoded-cwd dirs are cleaned up too.
 *
 * Never touches non-session shapes (files at the sessionRoot itself,
 * unexpected directory structures) — the sweep is intentionally
 * conservative.
 */
export function pruneSessionLogs(sessionRoot: string, maxAgeDays?: number): SessionSweepResult {
  const days = resolveMaxAgeDays(maxAgeDays);
  const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;
  const result: SessionSweepResult = { scanned: 0, removed: 0, bytesFreed: 0, cutoffMs };
  let projectDirs: fs.Dirent[];
  try {
    projectDirs = fs.readdirSync(sessionRoot, { withFileTypes: true });
  } catch {
    return result;
  }
  for (const proj of projectDirs) {
    if (!proj.isDirectory()) continue;
    const projPath = path.join(sessionRoot, proj.name);
    let sessions: fs.Dirent[];
    try {
      sessions = fs.readdirSync(projPath, { withFileTypes: true });
    } catch { continue; }
    for (const sess of sessions) {
      if (!sess.isDirectory()) continue;
      const sessPath = path.join(projPath, sess.name);
      result.scanned++;
      let mtime = 0;
      try { mtime = fs.statSync(sessPath).mtimeMs; } catch { continue; }
      if (mtime > cutoffMs) continue;
      // Also check the session.jsonl.zstd file's mtime if present — a resumed
      // session whose dir mtime is old but whose log was updated recently
      // should survive.
      try {
        const logPath = path.join(sessPath, "session.jsonl.zstd");
        if (fs.existsSync(logPath) && fs.statSync(logPath).mtimeMs > cutoffMs) continue;
        const legacy = path.join(sessPath, "session.jsonl");
        if (fs.existsSync(legacy) && fs.statSync(legacy).mtimeMs > cutoffMs) continue;
      } catch { /* fall through to remove */ }
      const size = dirSizeBytes(sessPath);
      try {
        fs.rmSync(sessPath, { recursive: true, force: true });
        result.removed++;
        result.bytesFreed += size;
      } catch { /* ignore */ }
    }
    // Best-effort: drop the encoded-cwd container if it's now empty.
    try {
      const remaining = fs.readdirSync(projPath);
      if (remaining.length === 0) fs.rmdirSync(projPath);
    } catch { /* ignore */ }
  }
  return result;
}
