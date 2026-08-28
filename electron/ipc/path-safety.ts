/**
 * Cairn — path-safety helpers for IPC handlers that touch filesystem paths.
 *
 * Every renderer→main IPC channel that ends in `fs.rmSync` / `fs.unlinkSync`
 * with an id supplied by the renderer is a potential path-traversal sink. The
 * pattern is universally `path.join(root, unvalidated_id, …)` — which, if the
 * id contains `../` segments, silently walks up outside `root`.
 *
 * This module centralises two guards used at every such site:
 *
 *   1. `assertSafeId(id)` — rejects anything but `[A-Za-z0-9._-]{1,128}`
 *      (matching how dsh + Cairn actually mint session ids and thread ids —
 *      thr-<nanoid>, chat-<threadId>, pi-<nanoid>, subagent uuids). Runs at
 *      the IPC boundary before any path composition; a rejected id short-
 *      circuits the handler.
 *   2. `resolveWithinRoot(root, ...segments)` — resolves the composed path
 *      and asserts it stays under `path.resolve(root) + sep`. Returns the
 *      resolved absolute path on success or null on escape, so callers can
 *      silently skip untrusted paths instead of crashing.
 *
 * Design rationale (why not just `path.normalize`?): normalize collapses
 * `../` but doesn't tell you whether the collapsed result is still inside
 * `root`. `resolve` + `startsWith(root + sep)` is the standard containment
 * check (mirrors the pattern already in `plugin-installer.ts:313`).
 */

import path from "node:path";

/**
 * Renderer-supplied ids must match this shape. Rejects `..`, `/`, `\`, `\x00`,
 * empty string, and anything longer than 128 chars. Covers every id shape
 * Cairn / dsh actually mint:
 *   - `thr-<nanoid>`         chat thread ids
 *   - `chat-<threadId>`      dsh stable session id for a chat thread
 *   - `chat-<threadId>-<ts>-<rand>`  legacy per-turn session id
 *   - `pi-<nanoid>`          coding-agent session ids
 *   - `<uuid-with-dashes>`   subagent child session ids
 */
const SAFE_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * Ids that match SAFE_ID_RE but are still path-unsafe on their own. `.` and
 * `..` are POSIX-special directory names; a raw `-` (or `-`-prefixed value)
 * can be interpreted as a flag by downstream tooling. We forbid the first
 * two outright; a lone `-` is allowed because it doesn't traverse anywhere.
 */
const RESERVED_IDS = new Set([".", ".."]);

/** Throws if `id` is not a safe renderer-supplied identifier. */
export function assertSafeId(id: unknown, kind = "id"): asserts id is string {
  if (typeof id !== "string" || !SAFE_ID_RE.test(id) || RESERVED_IDS.has(id)) {
    throw new Error(`unsafe ${kind}: must match [A-Za-z0-9._-]{1,128} and not be '.' or '..'`);
  }
}

/** Non-throwing predicate variant — useful for filter chains over lists. */
export function isSafeId(id: unknown): id is string {
  return typeof id === "string" && SAFE_ID_RE.test(id) && !RESERVED_IDS.has(id);
}

/**
 * Resolve `path.join(root, ...segments)` and assert the result stays under
 * `root`. Returns the resolved absolute path on success, or null when the
 * result escapes (via `..`, absolute segments, symlink-like tricks that
 * happen to be spelled in the input string).
 *
 * Note: this is a STRING-LEVEL check. It does NOT resolve symlinks — a
 * symlink already inside `root` that points outside is not caught. Symlink
 * handling belongs at the fs.rm layer (Node's `{recursive:true, force:true}`
 * follows them; use `realpathSync` first if that matters at a specific
 * callsite). The primary attack vector — a renderer sending an id
 * containing `..` — is fully closed by the string check.
 */
export function resolveWithinRoot(root: string, ...segments: string[]): string | null {
  const resolvedRoot = path.resolve(root);
  const composed = path.resolve(resolvedRoot, ...segments);
  // path.resolve normalises .. — a composed path that starts with the root
  // string (plus sep) is guaranteed inside. The trailing-sep check handles
  // the edge case where a segment happens to be the root's own name.
  const guard = resolvedRoot.endsWith(path.sep) ? resolvedRoot : resolvedRoot + path.sep;
  if (composed === resolvedRoot || composed.startsWith(guard)) return composed;
  return null;
}
