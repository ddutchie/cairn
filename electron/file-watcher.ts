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
import type Database from "better-sqlite3";
import { notesDir, parseNoteFile, upsertNoteFromFile } from "./notes-files";
import * as q from "./db/queries";

let watcher: FSWatcher | null = null;

// filePath → noteId, populated on add/change so delete can find the record
const pathToNoteId = new Map<string, string>();

/**
 * Starts watching the notes/ subdirectory of the workspace folder.
 * The `onChanged` callback is called after every SQLite mutation so the
 * main process can forward a db:changed event to the renderer.
 */
export function startFileWatcher(
  workspacePath: string,
  db: Database.Database,
  onChanged: () => void,
): void {
  stopFileWatcher();
  pathToNoteId.clear();

  const watchPath = notesDir(workspacePath);

  watcher = chokidar.watch(watchPath, {
    ignored: /(^|[/\\])\./, // ignore dotfiles
    persistent: true,
    ignoreInitial: true,    // don't fire for files already on disk at startup
    depth: 10,              // recurse into subfolders
    awaitWriteFinish: {
      stabilityThreshold: 200,
      pollInterval: 100,
    },
  });

  watcher
    .on("add",    (fp) => handleFileAdd(fp, db, onChanged))
    .on("change", (fp) => handleFileChange(fp, db, onChanged))
    .on("unlink", (fp) => handleFileDelete(fp, db, onChanged));
}

export function stopFileWatcher(): void {
  if (watcher) {
    watcher.close();
    watcher = null;
  }
  pathToNoteId.clear();
}

// ── Event handlers ────────────────────────────

function handleFileAdd(filePath: string, db: Database.Database, onChanged: () => void): void {
  if (!filePath.endsWith(".md")) return;
  const note = parseNoteFile(filePath);
  if (!note) return;
  pathToNoteId.set(filePath, note.id);
  upsertNoteFromFile(db, note);
  onChanged();
}

function handleFileChange(filePath: string, db: Database.Database, onChanged: () => void): void {
  if (!filePath.endsWith(".md")) return;
  const note = parseNoteFile(filePath);
  if (!note) return;
  pathToNoteId.set(filePath, note.id);
  upsertNoteFromFile(db, note);
  onChanged();
}

function handleFileDelete(filePath: string, db: Database.Database, onChanged: () => void): void {
  if (!filePath.endsWith(".md")) return;

  // Look up the note ID from our path map (file is already gone from disk)
  const noteId = pathToNoteId.get(filePath);
  pathToNoteId.delete(filePath);

  if (!noteId) return; // file was never tracked (e.g. not a Cairn note)

  try {
    q.deleteNote(db, noteId);
    onChanged();
  } catch {
    // Note may not exist in DB — ignore
  }
}
