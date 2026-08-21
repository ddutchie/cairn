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
