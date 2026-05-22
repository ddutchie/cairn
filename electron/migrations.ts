/**
 * Cairn — Migration Registry
 *
 * Extensible migration system for one-time workspace transformations.
 * Each migration has a unique ID, a check function to detect if it's needed,
 * and a run function that performs the actual transformation.
 *
 * Completed migrations are tracked in `<workspace>/.cairn-migrations.json`.
 *
 * Migration IDs are stable — once shipped, they should never be renamed
 * or removed so that the skip-list stays valid.
 */

import path from "path";
import fs from "fs";

// ── Types ─────────────────────────────────────────────────────────────────

export interface Migration {
  /** Stable unique identifier, e.g. "v1.5-drop-notes-dir" */
  id: string;
  /** Human-readable title shown in the migration modal */
  title: string;
  /** Description shown in the migration modal */
  description: string;
  /** Returns true if this migration is needed for the given workspace */
  check: (workspacePath: string) => boolean;
  /** Run the migration. Call onProgress(0–100, message) for UI updates. */
  run: (workspacePath: string, onProgress: (pct: number, msg: string) => void) => Promise<void>;
}

export interface MigrationStatus {
  id: string;
  title: string;
  description: string;
  needed: boolean;
}

// ── Tracking ──────────────────────────────────────────────────────────────

const MIGRATIONS_FILE = ".cairn-migrations.json";

function getCompletedMigrations(workspacePath: string): Set<string> {
  const fp = path.join(workspacePath, MIGRATIONS_FILE);
  try {
    if (!fs.existsSync(fp)) return new Set();
    const data = JSON.parse(fs.readFileSync(fp, "utf-8"));
    if (Array.isArray(data.completed)) return new Set(data.completed as string[]);
  } catch { /* ignore corrupt file */ }
  return new Set();
}

function markMigrationComplete(workspacePath: string, migrationId: string): void {
  const fp = path.join(workspacePath, MIGRATIONS_FILE);
  const completed = getCompletedMigrations(workspacePath);
  completed.add(migrationId);
  fs.writeFileSync(fp, JSON.stringify({
    completed: [...completed],
    lastRun: new Date().toISOString(),
  }, null, 2), "utf-8");
}

// ── Migration: drop-notes-dir ─────────────────────────────────────────────
// Moves notes from <ws>/notes/<project>/ → <ws>/<project>/
// for Obsidian vault compatibility.

const dropNotesDirMigration: Migration = {
  id: "v1.5-drop-notes-dir",
  title: "Restructure notes for Obsidian compatibility",
  description:
    "Moves notes from the internal notes/ folder to the workspace root. " +
    "Each project folder will sit directly at the workspace root, making " +
    "your workspace compatible with Obsidian vaults.",

  check(workspacePath: string): boolean {
    const notesDir = path.join(workspacePath, "notes");
    if (!fs.existsSync(notesDir)) return false;
    try {
      const entries = fs.readdirSync(notesDir);
      // If there are any .md files directly inside notes/, it's an Obsidian project folder named "notes"
      const hasDirectMd = entries.some((e) => e.endsWith(".md") && fs.lstatSync(path.join(notesDir, e)).isFile());
      if (hasDirectMd) return false;

      // Only needed if notes/ contains at least one directory (project folder)
      return entries.some((e) => {
        const fp = path.join(notesDir, e);
        return fs.lstatSync(fp).isDirectory() && !e.startsWith(".");
      });
    } catch {
      return false;
    }
  },

  async run(workspacePath: string, onProgress: (pct: number, msg: string) => void): Promise<void> {
    const notesDir = path.join(workspacePath, "notes");
    const entries = fs.readdirSync(notesDir).filter((e) => {
      const fp = path.join(notesDir, e);
      return fs.lstatSync(fp).isDirectory() && !e.startsWith(".");
    });

    if (entries.length === 0) {
      onProgress(100, "Nothing to migrate.");
      return;
    }

    // Phase 1: Copy all project folders
    for (let i = 0; i < entries.length; i++) {
      const projectSlug = entries[i];
      const src = path.join(notesDir, projectSlug);
      const dest = path.join(workspacePath, projectSlug);
      const pct = Math.round(((i + 0.5) / entries.length) * 80);
      onProgress(pct, `Copying ${projectSlug}...`);

      // If destination already exists, merge files into it
      fs.mkdirSync(dest, { recursive: true });
      copyDirRecursive(src, dest);
    }

    // Phase 2: Verify all files were copied
    onProgress(85, "Verifying...");
    for (const projectSlug of entries) {
      const src = path.join(notesDir, projectSlug);
      const dest = path.join(workspacePath, projectSlug);
      if (!verifyDirCopy(src, dest)) {
        throw new Error(`Verification failed for project "${projectSlug}". Migration aborted — no files were deleted.`);
      }
    }

    // Phase 3: Remove original notes/ directory
    onProgress(90, "Cleaning up...");
    try {
      fs.rmSync(notesDir, { recursive: true, force: true });
    } catch {
      // If we can't delete notes/, the migration still succeeded (files are at root)
      console.warn("[cairn:migration] Could not remove notes/ directory — manual cleanup may be needed.");
    }

    onProgress(100, `Migrated ${entries.length} project folder(s).`);
  },
};

// ── Helpers ───────────────────────────────────────────────────────────────

function copyDirRecursive(src: string, dest: string): void {
  for (const entry of fs.readdirSync(src)) {
    const srcPath = path.join(src, entry);
    const destPath = path.join(dest, entry);
    const stat = fs.lstatSync(srcPath);
    if (stat.isDirectory()) {
      fs.mkdirSync(destPath, { recursive: true });
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function verifyDirCopy(src: string, dest: string): boolean {
  for (const entry of fs.readdirSync(src)) {
    const srcPath = path.join(src, entry);
    const destPath = path.join(dest, entry);
    const stat = fs.lstatSync(srcPath);
    if (stat.isDirectory()) {
      if (!verifyDirCopy(srcPath, destPath)) return false;
    } else {
      if (!fs.existsSync(destPath)) return false;
      const srcSize = fs.statSync(srcPath).size;
      const destSize = fs.statSync(destPath).size;
      if (srcSize !== destSize) return false;
    }
  }
  return true;
}

// ── Registry ──────────────────────────────────────────────────────────────

/** All registered migrations, in order. Add new migrations at the end. */
const ALL_MIGRATIONS: Migration[] = [
  dropNotesDirMigration,
];

/**
 * Check which migrations are pending for a given workspace.
 * Returns a list of migration statuses.
 */
export function checkMigrations(workspacePath: string): MigrationStatus[] {
  const completed = getCompletedMigrations(workspacePath);
  return ALL_MIGRATIONS.map((m) => ({
    id: m.id,
    title: m.title,
    description: m.description,
    needed: !completed.has(m.id) && m.check(workspacePath),
  }));
}

/**
 * Run a specific migration by ID.
 * Returns true if the migration ran successfully.
 */
export async function runMigration(
  workspacePath: string,
  migrationId: string,
  onProgress: (pct: number, msg: string) => void,
): Promise<void> {
  const migration = ALL_MIGRATIONS.find((m) => m.id === migrationId);
  if (!migration) throw new Error(`Unknown migration: ${migrationId}`);

  await migration.run(workspacePath, onProgress);
  markMigrationComplete(workspacePath, migrationId);
}

/**
 * Run all pending migrations sequentially.
 */
export async function runAllPendingMigrations(
  workspacePath: string,
  onProgress: (migrationId: string, pct: number, msg: string) => void,
): Promise<number> {
  const completed = getCompletedMigrations(workspacePath);
  const pending = ALL_MIGRATIONS.filter((m) => !completed.has(m.id) && m.check(workspacePath));

  for (const m of pending) {
    await m.run(workspacePath, (pct, msg) => onProgress(m.id, pct, msg));
    markMigrationComplete(workspacePath, m.id);
  }

  return pending.length;
}
