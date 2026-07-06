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
 */
function skipIfOrphan(
  filePath: string,
  noteId: string,
  hadCairnId: boolean,
  db: Database.Database,
): boolean {
  if (!hadCairnId) return false; // adopted/new note — not an orphan
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

function handleFileDelete(filePath: string, db: Database.Database, onChanged: () => void): void {
  if (!filePath.endsWith(".md")) return;

  // Look up the note ID from our path map (file is already gone from disk)
  const noteId = pathToNoteId.get(filePath);
  pathToNoteId.delete(filePath);

  if (!noteId) return; // file was never tracked (e.g. not a Cairn note)

  // If the note is suppressed, the file was deleted by the app itself as part
  // of a rename/move (writeNoteFile deletes the old path before writing the new
  // one). The note still exists in SQLite under the new path — do not delete it.
  if (suppressedNoteIds.has(noteId)) return;

  try {
    q.deleteNote(db, noteId);
    onChanged();
  } catch {
    // Note may not exist in DB — ignore
  }
}
