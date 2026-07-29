/**
 * Cairn — Generic Note file I/O operations
 * Shared between the Electron process (notes-files.ts) and the MCP process (db.ts)
 * to avoid code duplication and format divergence.
 */

import path from "path";
import fs from "fs";
import matter from "gray-matter";
import { toSlug } from "./text-utils";

// ── Cairn-owned frontmatter keys ──────────────
// Only these keys are managed by Cairn. All other frontmatter fields
// (Obsidian tags, aliases, cssclass, date, publish, etc.) are preserved
// on every write cycle.
export const CAIRN_FRONTMATTER_KEYS = new Set([
  "id", "projectId", "workspaceId", "title", "folder",
  "tagIds", "linkedNoteIds", "linkedCardIds",
  "isPinned", "createdAt", "updatedAt", "archivedAt",
]);

/**
 * Read the existing frontmatter from a file on disk, returning all
 * non-Cairn keys as a record. Returns {} if the file doesn't exist,
 * has no frontmatter, or is unreadable.
 */
export function readExistingFrontmatter(filePath: string): Record<string, unknown> {
  try {
    if (!fs.existsSync(filePath)) return {};
    const { data } = matter(fs.readFileSync(filePath, "utf-8"));
    const extra: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
      if (!CAIRN_FRONTMATTER_KEYS.has(key)) {
        extra[key] = value;
      }
    }
    return extra;
  } catch {
    return {};
  }
}

// ── Path helpers ──────────────────────────────

export function notesDir(workspacePath: string): string {
  return workspacePath;
}

export function projectNotesDir(workspacePath: string, projectName: string): string {
  return path.join(workspacePath, toSlug(projectName));
}

/**
 * Returns the directory where a note with the given folder lives.
 * folder = ""           → <project-slug>/
 * folder = "A/B"        → <project-slug>/a/b/
 */
export function noteDir(workspacePath: string, projectName: string, folder: string): string {
  const base = projectNotesDir(workspacePath, projectName);
  if (!folder) return base;
  const segments = folder.split("/").filter(Boolean).map(toSlug);
  return path.join(base, ...segments);
}

/**
 * Resolve the file path for a note, given its title, project name, and folder.
 * If a file at <title>.md already exists with a *different* note ID in its
 * frontmatter, appends a short suffix to avoid collision:
 *   <title>-<shortId>.md
 */
export function resolveNoteFilePath(
  workspacePath: string,
  projectName: string,
  title: string,
  noteId: string,
  folder = "",
): string {
  const dir = noteDir(workspacePath, projectName, folder);
  const slug = toSlug(title);
  const candidate = path.join(dir, `${slug}.md`);

  if (!fs.existsSync(candidate)) return candidate;

  // File exists — check if it belongs to this note
  try {
    const { data } = matter(fs.readFileSync(candidate, "utf-8"));
    if (data.id === noteId) return candidate; // same note, reuse path
  } catch { /* unreadable — treat as collision */ }

  // Collision: append short ID suffix
  return path.join(dir, `${slug}-${noteId.slice(0, 6)}.md`);
}

/**
 * Find the current file path for a note by scanning the project folder
 * recursively for a file whose frontmatter `id` matches.
 * Returns null if not found.
 */
export function findNoteFilePath(
  workspacePath: string,
  projectName: string,
  noteId: string,
): string | null {
  const root = projectNotesDir(workspacePath, projectName);
  return findInDir(root, noteId);
}

function findInDir(dir: string, noteId: string): string | null {
  if (!fs.existsSync(dir)) return null;

  for (const entry of fs.readdirSync(dir)) {
    const fp = path.join(dir, entry);
    // Use lstatSync so symlinks are never followed
    const stat = fs.lstatSync(fp);
    if (stat.isDirectory()) {
      const found = findInDir(fp, noteId);
      if (found) return found;
    } else if (entry.endsWith(".md")) {
      try {
        const { data } = matter(fs.readFileSync(fp, "utf-8"));
        if (data.id === noteId) return fp;
      } catch { /* skip unreadable */ }
    }
  }
  return null;
}

/**
 * True when two paths denote the SAME file on disk.
 *
 * Needed because a plain string `===` is unsafe on case-insensitive filesystems
 * (macOS/Windows default): a note whose stored folder/title differs only in
 * CASE from its on-disk location yields a differently-cased computed path that
 * still refers to the same inode. Treating that as a distinct file makes
 * writeNoteFile misclassify a metadata-only write as a relocation and unlink
 * the file it just wrote — deleting the note.
 *
 * We compare real file identity via `statSync` device + inode. We deliberately
 * do NOT use `fs.realpathSync(.native)`: inside the packaged MCP binary (yao-pkg)
 * pkg's patched `fs.realpathSync.native` does NOT canonicalise case for real
 * files — it returns the path as given — so a case-variant of an existing file
 * compares unequal, sending the write down the relocation branch and DELETING
 * the note. `statSync` dev+ino is resolved by the real OS syscall and reports
 * the same inode for both casings under both plain Node and pkg (verified).
 *
 * When either path can't be stat'd (e.g. the target doesn't exist yet — a
 * genuine relocation, or a case-SENSITIVE FS where the variant truly is a
 * different, absent file), we return false so the relocation proceeds.
 */
function isSameFile(a: string, b: string): boolean {
  if (a === b) return true;
  try {
    const sa = fs.statSync(a);
    const sb = fs.statSync(b);
    return sa.dev === sb.dev && sa.ino === sb.ino;
  } catch { /* one side missing/unstattable — treat as different */ }
  return false;
}

export interface NoteFileData {
  id: string;
  projectId: string;
  workspaceId: string;
  title: string;
  content: string;
  contentText?: string;
  tagIds: string[];
  linkedNoteIds: string[];
  linkedCardIds: string[];
  isPinned: boolean;
  folder?: string;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
  /** Resolved project name — used for folder naming */
  projectName?: string;
  /**
   * When true, the on-disk filename is (re)derived from the note's title — used
   * by an explicit user-driven rename (rename_note), which also rewrites inbound
   * [[wikilinks]]. When false/omitted (the default for content edits, tag/pin
   * changes, and vault adoption) the existing filename is PRESERVED, so a title
   * or metadata change never renames the .md and breaks Obsidian wikilinks. A
   * folder change still relocates the file regardless of this flag.
   */
  renameFile?: boolean;
}

export function writeNoteFile(workspacePath: string, note: NoteFileData): void {
  const projectName = note.projectName ?? note.projectId;
  const folder = note.folder ?? "";
  const dir = noteDir(workspacePath, projectName, folder);
  fs.mkdirSync(dir, { recursive: true });

  const existingPath = findNoteFilePath(workspacePath, projectName, note.id);

  // Filename-stability rule (Obsidian compatibility):
  //
  // Obsidian resolves [[wikilinks]] by FILENAME, and it's common for a vault
  // note's filename to differ from its frontmatter `title`. If we recomputed the
  // path from toSlug(title) on every save, a content edit or metadata change (or
  // adopting a file whose title ≠ filename) would RENAME the .md on disk —
  // silently breaking every inbound wikilink (Obsidian's auto-link-update can't
  // fire for a change made outside Obsidian).
  //
  // So: when a file for this note already exists AND it already lives in the
  // target folder, KEEP its current filename — UNLESS renameFile is set (an
  // explicit rename_note, which also rewrites inbound wikilinks). We only compute
  // a fresh slug-based path when there is no file yet (brand-new note), the note
  // genuinely moved to a different folder, or a rename was explicitly requested.
  const existingDir = existingPath ? path.dirname(existingPath) : null;
  const stayInPlace =
    !note.renameFile &&
    existingPath != null &&
    existingDir != null &&
    isSameFile(existingDir, dir);

  const newPath = stayInPlace
    ? existingPath!
    : resolveNoteFilePath(workspacePath, projectName, note.title, note.id, folder);
  // Whether existingPath and newPath denote the SAME file on disk. A plain
  // string `===` is wrong on case-insensitive filesystems (macOS/Windows
  // default): a note whose stored folder/title differs only in CASE from its
  // on-disk path (e.g. folder "Research" vs the directory "research") computes a
  // different-cased newPath, is misclassified as a relocation, and the "remove
  // the old file" step then unlinks the very file it just wrote (both casings
  // are the same inode) — deleting the note. Compare the real resolved paths so
  // a case-only difference is treated as an in-place rewrite, not a move.
  const sameFile = existingPath != null && isSameFile(existingPath, newPath);

  // Read existing non-Cairn frontmatter (Obsidian tags, aliases, cssclass, etc.)
  const existingExtra = readExistingFrontmatter(existingPath ?? newPath);

  const cairnFields: Record<string, unknown> = {
    id: note.id,
    projectId: note.projectId,
    workspaceId: note.workspaceId,
    title: note.title,
    folder,
    tagIds: note.tagIds,
    linkedNoteIds: note.linkedNoteIds,
    linkedCardIds: note.linkedCardIds,
    isPinned: note.isPinned,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
  };
  if (note.archivedAt) cairnFields.archivedAt = note.archivedAt;

  // Merge: non-Cairn keys first, then Cairn keys on top (Cairn always wins).
  const frontmatter: Record<string, unknown> = { ...existingExtra, ...cairnFields };

  const serialized = matter.stringify(note.content ?? "", frontmatter);

  // Same-location rewrite (the common case: content/metadata edit, or a
  // link/tag/pin change that doesn't move the file) → write IN PLACE.
  //
  // We deliberately do NOT use the tmp-file + rename dance here. A
  // rename-over-an-existing-file changes the file's inode, which chokidar
  // reports as unlink+add of the note's own path. The file-watcher runs in a
  // separate process from the MCP server, and its only cross-process guard
  // against treating that unlink as a real delete is the mcp_active_writes lock
  // — but chokidar delivers the unlink event asynchronously, often AFTER the
  // MCP tool has already released the lock. That race let a metadata-only write
  // (e.g. link_note_to_task) tombstone the note. An in-place writeFileSync emits
  // only a `change` event, never an `unlink`, so the delete path can't fire.
  // (Atomicity is preserved for the risky case — a real relocation — below.)
  if (sameFile) {
    // Write to the path already on disk (existingPath), not the recomputed
    // newPath — they may differ only by case, and writing newPath on a
    // case-insensitive FS would rewrite the same file under a new-cased name
    // (still one inode) while leaving the DB↔disk casing subtly split.
    writeInPlaceDurable(existingPath, serialized);
    return;
  }

  // Relocation (title or folder changed → the file moves to a new path). Write
  // the new path atomically via tmp+rename, THEN remove the old file. Here the
  // unlink of the OLD path is expected and is what the watcher's relocation
  // guards (suppressedNoteIds / mcp_active_writes / noteFileStillExists) exist
  // to handle.
  const tmpPath = newPath + ".tmp";
  fs.writeFileSync(tmpPath, serialized, "utf-8");
  fs.renameSync(tmpPath, newPath);

  // Now safe to remove the old file (rename already succeeded)
  if (existingPath && !isSameFile(existingPath, newPath)) {
    try { fs.unlinkSync(existingPath); } catch { /* ignore */ }
    // A folder move can leave the old subfolder empty. Prune it (and any
    // parents it emptied) so stale, note-less folders don't linger in the
    // notes tree — but never remove the project root itself.
    pruneEmptyDirsUpTo(path.dirname(existingPath), projectNotesDir(workspacePath, projectName));
  }
}

/**
 * Overwrite an existing note file IN PLACE (keeping its inode/path — so the
 * file-watcher sees a `change`, never an `unlink`+`add`, and can't misfire the
 * cross-process delete race) while still surviving a mid-write crash.
 *
 * A bare truncating writeFileSync isn't crash-safe: if the process dies partway
 * through, the note is left truncated/corrupt. We therefore back the current
 * bytes up to a sibling `.bak` first, write the new content, fsync it to disk,
 * and only then drop the backup. On any error we restore the original from the
 * backup so a failed write never destroys the note. The rename-based atomic
 * write can't be used here because renaming over the target swaps its inode.
 */
function writeInPlaceDurable(targetPath: string, serialized: string): void {
  const backupPath = targetPath + ".bak";
  let backedUp = false;
  try {
    try {
      fs.copyFileSync(targetPath, backupPath);
      backedUp = true;
    } catch {
      // No readable original to back up (shouldn't happen on this branch, since
      // existingPath was found) — proceed without a backup rather than block.
    }

    const fd = fs.openSync(targetPath, "w");
    try {
      fs.writeFileSync(fd, serialized, "utf-8");
      fs.fsyncSync(fd); // durability: flush to disk before we drop the backup
    } finally {
      fs.closeSync(fd);
    }

    if (backedUp) {
      try { fs.unlinkSync(backupPath); } catch { /* best-effort cleanup */ }
    }
  } catch (err) {
    // Write failed — restore the original bytes so the note survives intact.
    if (backedUp) {
      try {
        fs.copyFileSync(backupPath, targetPath);
        fs.unlinkSync(backupPath);
      } catch { /* best-effort restore */ }
    }
    throw err;
  }
}

/**
 * Remove `startDir` and each of its ancestors if — and only if — they are
 * empty, walking upward until (but never including) `stopDir` (the project
 * notes root). Best-effort: any non-empty directory or filesystem error halts
 * the walk. Used after a note is moved or deleted so the folder it vacated
 * doesn't remain as a phantom empty entry in the notes tree.
 *
 * `startDir` and `stopDir` are compared as resolved absolute paths so a
 * relative/absolute mix (or trailing separators) can't let the walk escape
 * above the project root.
 */
export function pruneEmptyDirsUpTo(startDir: string, stopDir: string): void {
  try {
    const stop = path.resolve(stopDir);
    let dir = path.resolve(startDir);
    // Only prune inside the project root — bail if startDir is the root itself
    // or somewhere outside/above it.
    while (dir !== stop && dir.startsWith(stop + path.sep)) {
      let entries: string[];
      try {
        entries = fs.readdirSync(dir);
      } catch {
        return; // dir already gone or unreadable — stop
      }
      if (entries.length > 0) return; // not empty — leave it and everything above
      try {
        fs.rmdirSync(dir);
      } catch {
        return; // couldn't remove (race, permissions) — stop
      }
      dir = path.dirname(dir);
    }
  } catch {
    /* best-effort — never throw out of a file write */
  }
}

export function deleteNoteFile(
  workspacePath: string,
  projectName: string,
  noteId: string,
): void {
  const fp = findNoteFilePath(workspacePath, projectName, noteId);
  if (fp) {
    try { fs.unlinkSync(fp); } catch { /* ignore */ }
    // Deleting the last note in a subfolder empties it — prune the vacated
    // folder(s), stopping at the project root.
    pruneEmptyDirsUpTo(path.dirname(fp), projectNotesDir(workspacePath, projectName));
  }
}

/**
 * Delete the entire project notes folder (and all .md files inside it).
 * Called when a project is deleted.
 */
export function deleteProjectNotesDir(
  workspacePath: string,
  projectName: string,
): void {
  const dir = projectNotesDir(workspacePath, projectName);
  if (fs.existsSync(dir)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

/**
 * Rename a project's on-disk notes directory when the project is renamed, so
 * the `.md` files follow the new project name (their folder is derived from
 * `toSlug(projectName)`). Without this, a rename left the files under the old
 * slug and future writes went to a NEW folder — splitting one project across
 * two directories on disk.
 *
 * Best-effort and safe:
 *   - No-op when the slug is unchanged (e.g. a case-only rename that slugifies
 *     the same, or names that collapse to the same slug).
 *   - No-op when the old directory doesn't exist yet (no notes written).
 *   - If a directory already exists at the new slug, its files are MERGED in
 *     (moved individually, skipping any name collisions) rather than clobbered,
 *     then the emptied old directory is removed — never deletes note data.
 *
 * Returns true if anything was moved/renamed.
 */
export function renameProjectNotesDir(
  workspacePath: string,
  oldProjectName: string,
  newProjectName: string,
): boolean {
  const oldDir = projectNotesDir(workspacePath, oldProjectName);
  const newDir = projectNotesDir(workspacePath, newProjectName);
  if (oldDir === newDir) return false; // same slug — nothing to do
  if (!fs.existsSync(oldDir)) return false; // no files on disk yet

  try {
    if (!fs.existsSync(newDir)) {
      // Simple case: target free — rename the whole directory atomically.
      fs.renameSync(oldDir, newDir);
      return true;
    }
    // Target exists (rare): merge children instead of overwriting, so we never
    // lose notes. Move each entry that doesn't collide; recurse into subdirs.
    mergeDirInto(oldDir, newDir);
    // Remove the old dir if it's now empty. If only OS cruft remains (e.g. a
    // macOS .DS_Store) and no note files are left, clear it too so the renamed
    // folder doesn't linger on disk until the next app restart.
    removeDirIfNoNotesLeft(oldDir);
    return true;
  } catch {
    return false; // best-effort — leave files where they are on failure
  }
}

/** Recursively move entries from `src` into `dst`, skipping name collisions. */
function mergeDirInto(src: string, dst: string): void {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src)) {
    const from = path.join(src, entry);
    const to = path.join(dst, entry);
    const stat = fs.lstatSync(from);
    if (stat.isDirectory()) {
      mergeDirInto(from, to);
      try { fs.rmdirSync(from); } catch { /* ignore */ }
    } else if (!fs.existsSync(to)) {
      try { fs.renameSync(from, to); } catch { /* ignore collision/error */ }
    } else if (isStaleDuplicate(from, to)) {
      // Collision, but both files are the SAME Cairn note (same frontmatter id).
      // This happens when a note write raced the rename and already wrote the
      // note under the new slug — the destination copy is authoritative and the
      // source copy under the old slug is a stale duplicate. Remove it so the
      // old directory can be emptied (otherwise it lingers until an app restart).
      try { fs.unlinkSync(from); } catch { /* ignore */ }
    }
    // Otherwise: a genuine collision between different files — leave the source
    // in place (never destroy unrelated note data).
  }
}

/**
 * True if `from` and `to` are the same Cairn note file — i.e. both parse to the
 * same frontmatter `id`. Used by the merge to distinguish a stale duplicate
 * (safe to delete) from a genuine name collision between two different notes.
 */
function isStaleDuplicate(from: string, to: string): boolean {
  try {
    if (!from.endsWith(".md") || !to.endsWith(".md")) return false;
    const fromId = matter(fs.readFileSync(from, "utf-8")).data?.id;
    const toId = matter(fs.readFileSync(to, "utf-8")).data?.id;
    return typeof fromId === "string" && fromId.length > 0 && fromId === toId;
  } catch {
    return false;
  }
}

/**
 * Remove `dir` if it holds no real data, recursively. A merge/rename can leave
 * behind OS cruft (a macOS `.DS_Store`) or now-empty subdirectories that would
 * otherwise keep the renamed-away folder alive on disk. We never delete a dir
 * that still contains real data — that includes note (`.md`) files AND any
 * other user file (attachments, `.canvas`, images, etc.), so we don't destroy
 * non-note content that happens to live in a folder.
 */
function removeDirIfNoNotesLeft(dir: string): void {
  try {
    if (!fs.existsSync(dir)) return;
    if (dirContainsRealData(dir)) return; // real data remains — keep it
    fs.rmSync(dir, { recursive: true, force: true });
  } catch { /* best-effort */ }
}

/**
 * OS/tooling cruft filenames that never count as user data — safe to delete
 * along with an otherwise-empty directory.
 */
const OS_CRUFT_NAMES = new Set([".DS_Store", "Thumbs.db", "desktop.ini", ".localized"]);

/**
 * True if `dir` (recursively) contains at least one real file — i.e. any file
 * that is not explicitly-recognised OS cruft. Empty subdirectories and cruft
 * files do not count; everything else (notes, attachments, etc.) blocks
 * deletion so we never destroy non-note content.
 */
function dirContainsRealData(dir: string): boolean {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return false;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry);
    let stat: fs.Stats;
    try { stat = fs.lstatSync(full); } catch { continue; }
    if (stat.isDirectory()) {
      if (dirContainsRealData(full)) return true;
    } else if (!OS_CRUFT_NAMES.has(entry)) {
      return true;
    }
  }
  return false;
}

export function parseNoteFile(filePath: string): NoteFileData | null {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const { data, content } = matter(raw);

    // A valid Cairn note file must have at minimum an id and projectId
    if (typeof data.id !== "string" || typeof data.projectId !== "string") {
      return null;
    }

    return {
      id: data.id as string,
      projectId: data.projectId as string,
      workspaceId: (data.workspaceId as string) ?? "",
      title: (data.title as string) ?? path.basename(filePath, ".md"),
      content: content ?? "",
      tagIds: Array.isArray(data.tagIds) ? (data.tagIds as string[]) : [],
      linkedNoteIds: Array.isArray(data.linkedNoteIds) ? (data.linkedNoteIds as string[]) : [],
      linkedCardIds: Array.isArray(data.linkedCardIds) ? (data.linkedCardIds as string[]) : [],
      isPinned: data.isPinned === true,
      folder: typeof data.folder === "string" ? data.folder : "",
      createdAt: (data.createdAt as string) ?? new Date().toISOString(),
      updatedAt: (data.updatedAt as string) ?? new Date().toISOString(),
      archivedAt: data.archivedAt as string | undefined,
    };
  } catch {
    return null;
  }
}
