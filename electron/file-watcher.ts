/**
 * Cairn — File watcher
 *
 * Watches the notes/ directory inside the workspace folder for .md file
 * additions, changes, and deletions made externally (e.g. user editing in
 * another editor, git pull, etc.).
 *
 * On any change, it parses the frontmatter and upserts the note into SQLite
 * so that the app and MCP server see the updated content.
 *
 * Since filenames are now human-readable (not IDs), we maintain an in-memory
 * map of filePath → noteId so that delete events can look up the right record
 * even after the file is gone.
 *
 * Uses chokidar for reliable cross-platform file watching.
 */

import chokidar, { type FSWatcher } from "chokidar";
import fs from "fs";
import type Database from "better-sqlite3";
import { parseNoteFile, upsertNoteFromFile, adoptExternalNoteFile } from "./notes-files";
import { findNoteFilePath } from "./shared/notes-io";
import * as q from "./db/queries";

let watcher: FSWatcher | null = null;
let savedWorkspacePath: string | null = null;
let savedDb: Database.Database | null = null;
let savedOnChanged: (() => void) | null = null;

// filePath → noteId, populated on add/change so delete can find the record
const pathToNoteId = new Map<string, string>();

// Note IDs that the app itself just wrote — suppress the chokidar round-trip
// that would otherwise overwrite SQLite with the file we just saved from SQLite.
const suppressedNoteIds = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Call this immediately before writing a note file from the app (IPC handler).
 * Any chokidar change/add event for that note within the next 2 s is ignored.
 */
export function suppressNextChange(noteId: string): void {
  const existing = suppressedNoteIds.get(noteId);
  if (existing) clearTimeout(existing);
  suppressedNoteIds.set(
    noteId,
    setTimeout(() => suppressedNoteIds.delete(noteId), 2000),
  );
}

/**
 * Starts watching the workspace directory for .md file additions, changes,
 * and deletions. Ignores non-note directories like .obsidian, assets, etc.
 * The `onChanged` callback is called after every SQLite mutation so the
 * main process can forward a db:changed event to the renderer.
 */
export function startFileWatcher(
  workspacePath: string,
  db: Database.Database,
  onChanged: () => void,
): void {
  savedWorkspacePath = workspacePath;
  savedDb = db;
  savedOnChanged = onChanged;

  stopFileWatcher();
  pathToNoteId.clear();

  // Watch from workspace root — notes live at <ws>/<project-slug>/
  const watchPath = workspacePath;

  watcher = chokidar.watch(watchPath, {
    ignored: [
      /(^|[/\\])\./,              // dot-prefixed dirs/files (.obsidian, .trash, .git, etc.)
      '**/assets/**',             // Cairn legacy asset folder
      '**/attachments/**',        // Obsidian attachment folder
      /cairn\.db.*/,              // SQLite database files
      '**/*.tmp',                 // Atomic write temp files
    ],
    persistent: true,
    ignoreInitial: true,    // don't fire for files already on disk at startup
    depth: 10,              // recurse into subfolders
    awaitWriteFinish: {
      stabilityThreshold: 200,
      pollInterval: 100,
    },
  });

  watcher
    .on("add",    (fp) => handleFileAdd(fp, workspacePath, db, onChanged))
    .on("change", (fp) => handleFileChange(fp, workspacePath, db, onChanged))
    .on("unlink", (fp) => handleFileDelete(fp, db, onChanged));
}

/**
 * Test-only: seed the workspace path used by `shouldDeleteOnUnlink`'s
 * disk-existence backstop without starting a real chokidar watcher.
 */
export function __setWorkspacePathForTest(workspacePath: string | null): void {
  savedWorkspacePath = workspacePath;
}

export function stopFileWatcher(): void {
  if (watcher) {
    watcher.close();
    watcher = null;
  }
  pathToNoteId.clear();
}

export function pauseFileWatcher(): void {
  stopFileWatcher();
}

export function resumeFileWatcher(): void {
  if (savedWorkspacePath && savedDb && savedOnChanged) {
    startFileWatcher(savedWorkspacePath, savedDb, savedOnChanged);
  }
}

// ── Event handlers ────────────────────────────

/**
 * Guard against note resurrection from orphaned .md files.
 *
 * When a note is deleted, its DB row is removed and its .md file is unlinked.
 * But in a synced workspace a PEER may re-materialise that .md on disk (its own
 * copy hadn't received the delete yet, or a sync race). Chokidar then fires an
 * `add`, and without this guard the watcher would re-import the file, recreate
 * the row, and the capture trigger would publish a fresh `put` — fighting the
 * delete forever (the "conflict copies keep coming back" loop).
 *
 * The distinguishing fact: a note that legitimately arrives via sync gets its
 * DB row written by the engine's projector BEFORE (or with) the .md file, so by
 * the time we observe the file the row exists. A file that carries a real Cairn
 * id in its frontmatter but has NO matching DB row is therefore an orphan of a
 * deleted note. We delete the orphan and skip the import.
 *
 * (Files with no Cairn frontmatter are handled by adoptExternalNoteFile with a
 * fresh id — genuinely new external notes — so they never hit this path.)
 *
 * `hadCairnId` is true when parseNoteFile (not adoption) produced the note, i.e.
 * the file already claimed an existing id. Returns true if it handled (skipped).
 *
 * IMPORTANT: this must never fire for a note that is *currently being created*.
 * When a note is written by the in-app AI chat executor or the MCP server, the
 * `.md` file lands on disk and chokidar fires `add` before the SQLite row is
 * necessarily visible to this (separate-statement) read — especially when the
 * target folder is already watched, so the `add` arrives with near-zero delay.
 * Without the in-flight guards below, we would misclassify a brand-new note as
 * a deleted-note orphan and unlink the file we just wrote (note vanishes). We
 * therefore skip the orphan verdict while the id is suppressed (our own write)
 * or present in `mcp_active_writes` (an in-flight MCP-side write).
 */
function skipIfOrphan(
  filePath: string,
  noteId: string,
  hadCairnId: boolean,
  db: Database.Database,
): boolean {
  if (!hadCairnId) return false; // adopted/new note — not an orphan
  // In-flight write (this process) — the row may not be committed/visible yet.
  if (suppressedNoteIds.has(noteId)) return false;
  // In-flight write (MCP server process) — same reasoning, cross-process signal.
  if (q.getActiveMcpWrites(db).has(noteId)) return false;
  const exists = db.prepare("SELECT 1 FROM notes WHERE id = ?").get(noteId);
  if (exists) return false; // live note — normal upsert
  // Real Cairn id, no row → orphan of a deleted note. Remove it.
  suppressNextChange(noteId); // the unlink we're about to do is ours, not a user delete
  try { fs.unlinkSync(filePath); } catch { /* already gone */ }
  pathToNoteId.delete(filePath);
  return true;
}

function handleFileAdd(filePath: string, workspacePath: string, db: Database.Database, onChanged: () => void): void {
  if (!filePath.endsWith(".md")) return;
  let note = parseNoteFile(filePath);
  const hadCairnId = note !== null;
  // Plain .md file with no Cairn frontmatter — try to adopt it
  if (!note) note = adoptExternalNoteFile(db, workspacePath, filePath);
  if (!note) return;
  if (skipIfOrphan(filePath, note.id, hadCairnId, db)) return;
  pathToNoteId.set(filePath, note.id);
  if (suppressedNoteIds.has(note.id)) return;
  upsertNoteFromFile(db, note);
  onChanged();
}

function handleFileChange(filePath: string, workspacePath: string, db: Database.Database, onChanged: () => void): void {
  if (!filePath.endsWith(".md")) return;
  let note = parseNoteFile(filePath);
  const hadCairnId = note !== null;
  // Plain .md file — try to adopt (e.g. frontmatter was stripped by external editor)
  if (!note) note = adoptExternalNoteFile(db, workspacePath, filePath);
  if (!note) return;
  if (skipIfOrphan(filePath, note.id, hadCairnId, db)) return;
  pathToNoteId.set(filePath, note.id);
  if (suppressedNoteIds.has(note.id)) return;
  upsertNoteFromFile(db, note);
  onChanged();
}

/**
 * True if a .md file carrying this note's id still exists somewhere in the
 * note's project directory. Used by the delete handler to distinguish a real
 * external deletion (no file left) from a relocation whose old-path `unlink`
 * fired without the write lock covering it (file re-materialised under the new
 * path). Best-effort: on any lookup failure we return false so a genuine delete
 * is never suppressed.
 */
function noteFileStillExists(db: Database.Database, noteId: string): boolean {
  if (!savedWorkspacePath) return false;
  try {
    const row = db
      .prepare(
        "SELECT p.name AS projectName FROM notes n JOIN projects p ON p.id = n.project_id WHERE n.id = ?",
      )
      .get(noteId) as { projectName: string } | undefined;
    if (!row?.projectName) return false;
    return findNoteFilePath(savedWorkspacePath, row.projectName, noteId) !== null;
  } catch {
    return false;
  }
}

function handleFileDelete(filePath: string, db: Database.Database, onChanged: () => void): void {
  if (!filePath.endsWith(".md")) return;

  // Look up the note ID from our path map (file is already gone from disk)
  const noteId = pathToNoteId.get(filePath);
  pathToNoteId.delete(filePath);

  if (!noteId) return; // file was never tracked (e.g. not a Cairn note)

  if (!shouldDeleteOnUnlink(db, noteId)) return;

  try {
    q.deleteNote(db, noteId);
    onChanged();
  } catch {
    // Note may not exist in DB — ignore
  }
}

/**
 * Decide whether an `unlink` of a tracked note file means the note was really
 * deleted (return true) or merely relocated / being written (return false).
 *
 * A note's `.md` is unlinked from its old path during a rename or folder move
 * (writeNoteFile writes the new path first, then removes the old one). If we
 * deleted the row on every unlink, those relocations would wipe the note. We
 * therefore suppress the delete when any of these hold:
 *   - the id is in `suppressedNoteIds` (this process just wrote it), or
 *   - the id is in `mcp_active_writes` (an in-flight MCP-side write), or
 *   - a `.md` for this id still exists elsewhere in the project (moved, not
 *     deleted) — the timing-independent backstop for the two locks above.
 *
 * Exported for unit testing; `handleFileDelete` is the sole runtime caller.
 */
export function shouldDeleteOnUnlink(db: Database.Database, noteId: string): boolean {
  if (suppressedNoteIds.has(noteId)) return false;
  if (q.getActiveMcpWrites(db).has(noteId)) return false;
  if (noteFileStillExists(db, noteId)) return false;
  return true;
}
