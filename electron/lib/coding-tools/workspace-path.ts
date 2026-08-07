/**
 * Workspace-scoped path resolution for the coding-agent file tools.
 *
 * The tools only read inside the agent's working directory. This resolves a
 * user-supplied `path` against `cwd` and verifies the RESOLVED location is
 * actually inside the real (symlink-resolved) cwd — rejecting absolute paths
 * and parent traversal that escape the workspace, and symlinks that point out
 * of it. This stops a tool from reading arbitrary system files (e.g.
 * /etc/passwd) or hanging on special files (/dev/random). Valid in-workspace
 * operations (relative paths, and absolute paths that resolve inside cwd)
 * keep working.
 *
 * Note: the recursive walkers (grep/find) never follow symlinks — readdir with
 * `withFileTypes` reports a symlink's lstat shape, so `isDirectory()` is false
 * for a symlinked directory. Containing the root input is therefore sufficient.
 */

import fs from "fs";
import path from "path";

function isInside(base: string, target: string): boolean {
  const rel = path.relative(base, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Resolve `input` against `cwd` and confirm it stays inside the workspace.
 * Returns the resolved absolute path, or null when the input escapes (absolute
 * outside, `..` parent traversal, or a symlink pointing out of the workspace).
 * A missing path passes the containment check so the caller's own
 * stat/readdir/readFile can report the normal "not found" error.
 */
export function resolveContainedPath(cwd: string, input?: string): string | null {
  const base = path.resolve(cwd);
  const target = input ? path.resolve(base, input) : base;
  if (!isInside(base, target)) return null;
  // Symlink-escape check — realpath the target only if it exists (realpath of a
  // missing path throws; the caller reports "not found" via its own stat/read).
  try {
    const realBase = fs.realpathSync(base);
    const realTarget = fs.realpathSync(target);
    if (!isInside(realBase, realTarget)) return null;
  } catch {
    /* base or target doesn't exist — containment on the unresolved path is enough */
  }
  return target;
}
