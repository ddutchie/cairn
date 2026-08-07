import path from "path";
import fs from "fs";
import { createHash } from "crypto";
import matter from "gray-matter";
import type Database from "better-sqlite3";
import * as q from "./db/queries";
import { newId } from "./db/utils";
import { toSlug, stripMarkdown } from "./shared/text-utils";
import { DEFAULT_COLUMNS } from "./db/defaults";
import {
  readExistingFrontmatter,
  notesDir,
  projectNotesDir,
  noteDir,
  resolveNoteFilePath,
  findNoteFilePath,
  NoteFileData as NoteData,
  writeNoteFile,
  deleteNoteFile,
  hardDeleteNoteFile,
  deleteProjectNotesDir,
  renameProjectNotesDir,
  parseNoteFile,
  pruneEmptyDirsUpTo,
  setPathRemover,
  CAIRN_FRONTMATTER_KEYS
} from "./shared/notes-io";

export {
  toSlug,
  stripMarkdown,
  readExistingFrontmatter,
  notesDir,
  projectNotesDir,
  noteDir,
  resolveNoteFilePath,
  findNoteFilePath,
  NoteData,
  writeNoteFile,
  deleteNoteFile,
  hardDeleteNoteFile,
  deleteProjectNotesDir,
  renameProjectNotesDir,
  parseNoteFile,
  pruneEmptyDirsUpTo,
  setPathRemover
};

const IMPORT_CONFIG_FILE = ".cairn-import.json";
const DEFAULT_SKIP_DIRS = new Set(["assets", "attachments", "templates"]);

export interface VaultImportPreview {
  isObsidianVault: boolean;
  vaultName: string;
  noteCount: number;
  skippedCount: number;
  projects: Array<{ name: string; noteCount: number; root: boolean; projectKey: string }>;
  excludedFolders: string[];
}

function isSkippedMarkdown(name: string): boolean {
  const lower = name.toLowerCase();
  return !lower.endsWith(".md") || lower.endsWith(".md.tmp") || lower.endsWith(".excalidraw.md");
}

function isSkippedDirectory(name: string): boolean {
  return name.startsWith(".") || DEFAULT_SKIP_DIRS.has(name.toLowerCase());
}

// ── Import configuration (exclusions + adoption ledger + unmanaged flag) ─────
//
// `.cairn-import.json` holds the workspace's import state:
//   { excludedFolders: string[], adopted: { [noteId]: { path, bodyHash } }, unmanaged?: boolean }
// - `excludedFolders` — top-level folder names never imported (v2.6.1).
// - `adopted` — the adoption ledger: every note Cairn adopted from disk, keyed by
//   note id, with the workspace-relative path and the sha256 of its body at
//   adoption. This is the baseline for the re-import 3-way conflict check.
// - `unmanaged` — set by import rollback: the vault was un-adopted, so scans and
//   the watcher leave its files as plain markdown (never re-adopt them).
//
// Resilience (unchanged from v2.6.1): the file is written atomically; a
// malformed/truncated config falls back to the last known-good copy, and a
// never-valid config HALTS imports until repaired — never failing open.

export interface ImportAdoptedEntry {
  /** Workspace-relative path of the file (diagnostics / rollback). */
  path: string;
  /** sha256 of the note body at adoption — the 3-way conflict baseline. */
  bodyHash: string;
}

export interface ImportConfig {
  excludedFolders: string[];
  adopted: Record<string, ImportAdoptedEntry>;
  unmanaged: boolean;
}

const EMPTY_CONFIG: ImportConfig = { excludedFolders: [], adopted: {}, unmanaged: false };

const lastValidConfigs = new Map<string, ImportConfig>();
// Workspaces whose config file exists but is currently unreadable/malformed AND
// was never parsed successfully. Imports HALT for these until the file is
// repaired — no silent adoption of previously-excluded folders.
const haltedWorkspaces = new Set<string>();

export function readImportConfig(workspacePath: string): ImportConfig {
  const configPath = path.join(workspacePath, IMPORT_CONFIG_FILE);
  let raw: string;
  try {
    raw = fs.readFileSync(configPath, "utf-8");
  } catch (err) {
    // A genuinely missing config means "no exclusions" — clear the workspace's
    // cached state. Any OTHER read failure means the file exists but is
    // currently unreadable: fall back to the last valid set, else halt.
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      lastValidConfigs.delete(workspacePath);
      haltedWorkspaces.delete(workspacePath);
      return { ...EMPTY_CONFIG };
    }
    if (lastValidConfigs.has(workspacePath)) return { ...lastValidConfigs.get(workspacePath)! };
    haltedWorkspaces.add(workspacePath);
    return { ...EMPTY_CONFIG };
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    // ANY non-string entry (not just some) makes the whole file invalid — a
    // single bad value means we can't trust the list, so it must fall back/halt
    // rather than silently dropping entries and importing folders the user
    // intended to keep out.
    if (
      !parsed ||
      typeof parsed !== "object" ||
      !Array.isArray((parsed as { excludedFolders?: unknown }).excludedFolders) ||
      (parsed as { excludedFolders: unknown[] }).excludedFolders.some((v) => typeof v !== "string")
    ) {
      throw new Error("invalid shape");
    }
    const p = parsed as { excludedFolders: string[]; adopted?: unknown; unmanaged?: unknown };
    // The ledger is tolerant: a missing/malformed `adopted` just means "no
    // baselines" (re-import falls back to timestamp logic), never a halt.
    const adopted: Record<string, ImportAdoptedEntry> = {};
    if (p.adopted && typeof p.adopted === "object" && !Array.isArray(p.adopted)) {
      for (const [id, entry] of Object.entries(p.adopted as Record<string, unknown>)) {
        if (entry && typeof entry === "object" && !Array.isArray(entry)) {
          const e = entry as { path?: unknown; bodyHash?: unknown };
          if (typeof e.path === "string" && typeof e.bodyHash === "string") {
            adopted[id] = { path: e.path, bodyHash: e.bodyHash };
          }
        }
      }
    }
    const cfg: ImportConfig = {
      excludedFolders: [...new Set(p.excludedFolders)].sort(),
      adopted,
      unmanaged: p.unmanaged === true,
    };
    lastValidConfigs.set(workspacePath, cfg);
    haltedWorkspaces.delete(workspacePath);
    return cfg;
  } catch {
    // Present but malformed/truncated. Never fail open: fall back to the last
    // valid config we parsed. If we never parsed a valid file, halt imports
    // for this workspace until the file is repaired.
    if (lastValidConfigs.has(workspacePath)) return { ...lastValidConfigs.get(workspacePath)! };
    haltedWorkspaces.add(workspacePath);
    return { ...EMPTY_CONFIG };
  }
}

/** True when the workspace's import config is present but broken beyond the last-known-good copy. */
export function isImportConfigHalted(workspacePath: string): boolean {
  return haltedWorkspaces.has(workspacePath);
}

function readImportExclusions(workspacePath: string): Set<string> {
  return new Set(readImportConfig(workspacePath).excludedFolders);
}

/** Shared watcher/scanner boundary: true when a path must never be imported. */
export function isImportPathExcluded(workspacePath: string, filePath: string): boolean {
  const rel = path.relative(notesDir(workspacePath), filePath);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return true;
  const segments = rel.split(path.sep);
  if (segments.some((segment) => isSkippedDirectory(segment))) return true;
  if (isSkippedMarkdown(segments[segments.length - 1])) return true;
  // Load/parse the config (which REGISTERS the halted state for a malformed
  // newly-encountered file) after the cheap lexical checks, then evaluate the
  // refreshed halt state. Checking halt before reading would miss a config that
  // just turned malformed, letting root notes and nested files through.
  const config = readImportConfig(workspacePath);
  if (isImportConfigHalted(workspacePath)) return true;
  // A rolled-back (un-managed) vault is never re-adopted.
  if (config.unmanaged) return true;
  return segments.length > 1 && config.excludedFolders.includes(segments[0]);
}

/** Atomically persist the workspace's import config (never a truncated file). */
function writeImportConfig(workspacePath: string, cfg: ImportConfig): void {
  const clean = [...new Set(cfg.excludedFolders.filter((name) => name && !name.startsWith(".")))].sort();
  const body = JSON.stringify({
    excludedFolders: clean,
    ...(Object.keys(cfg.adopted).length > 0 ? { adopted: cfg.adopted } : {}),
    ...(cfg.unmanaged ? { unmanaged: true } : {}),
  }, null, 2) + "\n";
  const target = path.join(workspacePath, IMPORT_CONFIG_FILE);
  // Write via a temp file + atomic rename so a crash mid-write can never leave a
  // truncated config that readImportConfig would then reject.
  const tmp = path.join(workspacePath, `${IMPORT_CONFIG_FILE}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, body, "utf-8");
  try {
    fs.renameSync(tmp, target);
  } catch {
    // Cross-device or locked-target fallback — write in place, clean up the temp.
    fs.writeFileSync(target, body, "utf-8");
    try { fs.unlinkSync(tmp); } catch { /* best effort */ }
  }
  // Refresh the cached copy so a subsequent read in the same process sees it.
  lastValidConfigs.set(workspacePath, { excludedFolders: clean, adopted: cfg.adopted, unmanaged: cfg.unmanaged });
  haltedWorkspaces.delete(workspacePath);
}

export function saveImportExclusions(workspacePath: string, excludedFolders: string[]): void {
  const current = readImportConfig(workspacePath);
  writeImportConfig(workspacePath, { ...current, excludedFolders });
}

// ── Adoption ledger (3-way re-import baseline) ────────────────────────────────

function bodyHash(content: string): string {
  // Normalise trailing whitespace so the same note hashes identically whether
  // it came from the DB row (raw body) or a file (matter.stringify adds a
  // trailing newline) — otherwise every re-scan looks like an "external edit".
  return createHash("sha256").update((content ?? "").replace(/\s+$/, "")).digest("hex");
}

/** Pending ledger entries, merged into the config file once per scan (avoids a
 *  config rewrite for every adopted note during a bulk vault import). */
const pendingAdopted = new Map<string, Record<string, ImportAdoptedEntry>>();

function recordAdoption(workspacePath: string, id: string, relPath: string, content: string): void {
  let map = pendingAdopted.get(workspacePath);
  if (!map) { map = {}; pendingAdopted.set(workspacePath, map); }
  map[id] = { path: relPath, bodyHash: bodyHash(content) };
}

/** Refresh an adopted note's baseline to its current content — the row and file
 *  are now in sync (a Cairn/MCP write echoed by the watcher, or an external
 *  edit just adopted). Keeps the 3-way check measuring "since the last time
 *  both sides agreed", so a later external edit isn't mistaken for a
 *  both-changed conflict. Pending-flushed like recordAdoption. */
export function touchAdoptedBaseline(workspacePath: string, id: string, content: string): void {
  let map = pendingAdopted.get(workspacePath);
  if (!map) { map = {}; pendingAdopted.set(workspacePath, map); }
  const existing = map[id] ?? readImportConfig(workspacePath).adopted[id];
  if (!existing) return; // not an adopted note (e.g. a Cairn-created note)
  map[id] = { path: existing.path ?? "", bodyHash: bodyHash(content) };
}

/** Merge pending adoption entries into the config file. Idempotent; no-op when
 *  nothing was recorded. Exported so the file watcher flushes single-note
 *  adoptions too. */
export function flushAdoptedLedger(workspacePath: string): void {
  const pending = pendingAdopted.get(workspacePath);
  if (!pending || Object.keys(pending).length === 0) return;
  pendingAdopted.delete(workspacePath);
  const cfg = readImportConfig(workspacePath);
  writeImportConfig(workspacePath, { ...cfg, adopted: { ...cfg.adopted, ...pending } });
}

/** Drop ledger entries for note ids no longer managed (rollback / delete). */
export function removeAdoptedEntries(workspacePath: string, ids: string[]): void {
  if (ids.length === 0) return;
  const cfg = readImportConfig(workspacePath);
  let changed = false;
  for (const id of ids) {
    if (id in cfg.adopted) { delete cfg.adopted[id]; changed = true; }
  }
  if (changed) writeImportConfig(workspacePath, cfg);
}

/** Mark the vault un-managed (import rollback): scans and the watcher then leave
 *  its files as plain markdown — never re-adopt them. */
export function setImportUnmanaged(workspacePath: string, unmanaged: boolean): void {
  const cfg = readImportConfig(workspacePath);
  if (cfg.unmanaged === unmanaged) return;
  writeImportConfig(workspacePath, { ...cfg, unmanaged });
}

/** Set/unset the sync capture-trigger suppression flag (see migration v26).
 *  Wrapped in try/catch so a sync-less setup can never break a rollback. */
function setSyncSuppressed(db: Database.Database, on: boolean): void {
  try {
    db.prepare(
      "INSERT INTO sync_state (key, value) VALUES ('suppress', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run(on ? "1" : "0");
  } catch (err) {
    console.warn("[import] sync suppress toggle failed:", err);
  }
}

/** Strip Cairn's frontmatter keys from a file, preserving the user's own keys
 *  (Obsidian tags, aliases, dates, custom properties, …). If only Cairn
 *  frontmatter remains, the file is rewritten as plain markdown. */
function stripCairnFrontmatterFromFile(filePath: string): void {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const { data, content } = matter(raw);
    const clean: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
      if (!CAIRN_FRONTMATTER_KEYS.has(key)) clean[key] = value;
    }
    const body = Object.keys(clean).length > 0
      ? matter.stringify(content, clean)
      : (content ?? "").trimStart();
    fs.writeFileSync(filePath, body, "utf-8");
  } catch {
    /* best-effort — an unreadable/unwritable file is left untouched */
  }
}

/**
 * Roll back an import: remove the given projects and their notes WITHOUT
 * publishing sync tombstones to peers, strip Cairn frontmatter from the adopted
 * files (preserving the user's own frontmatter), drop their ledger entries, and
 * mark the vault un-managed so the next scan leaves the files as plain markdown
 * instead of re-adopting them.
 *
 * Intended for "immediately after import, before edits" — the rescan result's
 * createdProjects. Returns the number of notes removed.
 */
export function rollbackImport(
  db: Database.Database,
  workspacePath: string,
  projectIds: string[],
): number {
  const ids = [...new Set(projectIds.filter((id) => typeof id === "string" && id.length > 0))];
  if (ids.length === 0) return 0;
  const cfg = readImportConfig(workspacePath);
  if (cfg.unmanaged) return 0; // already rolled back

  const placeholders = ids.map(() => "?").join(",");
  // Notes under the target projects — for file stripping + ledger cleanup.
  const notes = db.prepare(
    `SELECT n.id, p.name AS project_name
     FROM notes n JOIN projects p ON n.project_id = p.id
     WHERE n.project_id IN (${placeholders}) AND n.type = 'note'`,
  ).all(...ids) as Array<{ id: string; project_name: string }>;

  // Strip Cairn frontmatter from each adopted file (best-effort), leaving the
  // user's own frontmatter and the note body intact.
  for (const n of notes) {
    const fp = findNoteFilePath(workspacePath, n.project_name, n.id);
    if (fp) stripCairnFrontmatterFromFile(fp);
  }

  // Delete the projects (cascades to their note rows) under sync-capture
  // suppression so no tombstones propagate to synced peers — rollback is an
  // un-adopt, not a delete.
  setSyncSuppressed(db, true);
  try {
    db.prepare(`DELETE FROM projects WHERE id IN (${placeholders})`).run(...ids);
  } finally {
    setSyncSuppressed(db, false);
  }

  // Drop the ledger entries and mark the vault un-managed in one config write.
  const adopted = { ...cfg.adopted };
  for (const n of notes) delete adopted[n.id];
  writeImportConfig(workspacePath, { ...cfg, adopted, unmanaged: true });

  return notes.length;
}

function countImportableMarkdown(dir: string): { included: number; skipped: number } {
  let included = 0;
  let skipped = 0;
  let entries: string[];
  try { entries = fs.readdirSync(dir); } catch { return { included, skipped }; }
  for (const entry of entries) {
    const fp = path.join(dir, entry);
    let stat: fs.Stats;
    try { stat = fs.lstatSync(fp); } catch { continue; }
    if (stat.isDirectory()) {
      if (isSkippedDirectory(entry)) {
        skipped += countAllMarkdown(fp);
      } else {
        const nested = countImportableMarkdown(fp);
        included += nested.included;
        skipped += nested.skipped;
      }
    } else if (entry.toLowerCase().endsWith(".md")) {
      if (isSkippedMarkdown(entry)) skipped++; else included++;
    }
  }
  return { included, skipped };
}

function countAllMarkdown(dir: string): number {
  let count = 0;
  let entries: string[];
  try { entries = fs.readdirSync(dir); } catch { return 0; }
  for (const entry of entries) {
    const fp = path.join(dir, entry);
    let stat: fs.Stats;
    try { stat = fs.lstatSync(fp); } catch { continue; }
    if (stat.isDirectory()) count += countAllMarkdown(fp);
    else if (entry.toLowerCase().endsWith(".md") && !entry.toLowerCase().endsWith(".md.tmp")) count++;
  }
  return count;
}

/** Read-only recursive preview. Never parses or writes note contents. */
export function previewVaultImport(workspacePath: string): VaultImportPreview {
  const result: VaultImportPreview = {
    isObsidianVault: fs.existsSync(path.join(workspacePath, ".obsidian")),
    vaultName: path.basename(workspacePath) || "Notes",
    noteCount: 0,
    skippedCount: 0,
    projects: [],
    excludedFolders: [...readImportExclusions(workspacePath)].sort(),
  };
  let entries: string[];
  try { entries = fs.readdirSync(workspacePath); } catch { return result; }
  let rootNotes = 0;
  for (const entry of entries) {
    const fp = path.join(workspacePath, entry);
    let stat: fs.Stats;
    try { stat = fs.lstatSync(fp); } catch { continue; }
    if (stat.isDirectory()) {
      if (isSkippedDirectory(entry)) {
        result.skippedCount += countAllMarkdown(fp);
        continue;
      }
      // Mirror the import filtering (importVaultProjects / syncDir): a legacy
      // `notes/` folder is only a project when it's part of an Obsidian vault or
      // has direct .md files. Without this the preview can promise a nonzero
      // import for a `notes/` tree the scan would then skip entirely.
      if (entry === "notes" && !isImportableNotesFolder(workspacePath)) {
        result.skippedCount += countAllMarkdown(fp);
        continue;
      }
      const counts = countImportableMarkdown(fp);
      result.skippedCount += counts.skipped;
      if (counts.included > 0) result.projects.push({ name: entry, noteCount: counts.included, root: false, projectKey: toSlug(entry) });
    } else if (entry.toLowerCase().endsWith(".md")) {
      if (isSkippedMarkdown(entry)) result.skippedCount++; else rootNotes++;
    }
  }
  if (rootNotes > 0) result.projects.unshift({ name: result.vaultName, noteCount: rootNotes, root: true, projectKey: toSlug(result.vaultName) });
  result.noteCount = result.projects.reduce((sum, project) => sum + project.noteCount, 0);
  return result;
}


// ── Startup sync ──────────────────────────────
//
// Walks the entire notes directory on startup and reconciles .md files with
// SQLite. Two cases are handled:
//
//  1. Note missing from SQLite → always import (crash recovery).
//  2. Note present in SQLite but .md is newer → overwrite SQLite content.
//     Detects notes edited in an external editor while Cairn was closed.
//     Uses frontmatter updatedAt as primary signal; falls back to file mtime
//     (with a 2-second buffer for filesystem precision differences).
//
// Also cleans up any stale *.md.tmp files left by a crash during an atomic write.

export function syncNotesFromDisk(db: Database.Database, workspacePath: string, workspaceId?: string): void {
  const root = notesDir(workspacePath);
  if (!fs.existsSync(root)) return;
  cleanStaleTmpFiles(root);
  // A malformed import config with no known-good value halts the scan rather
  // than adopting folders the user may have excluded. Reading the exclusions
  // first is what registers the halted state for a never-valid config.
  // A malformed import config with no known-good value halts the scan rather
  // than adopting folders the user may have excluded. Reading the exclusions
  // first is what registers the halted state for a never-valid config.
  readImportExclusions(workspacePath);
  if (isImportConfigHalted(workspacePath)) return;
  // Auto-create projects for any top-level folders (and loose root .md files)
  // that don't yet have a matching project in the DB. This is what lets a user
  // point Cairn at an existing Obsidian vault — or copy a folder of notes into
  // the workspace — and have projects + notes appear. Best-effort: if there is
  // no workspace yet (first-run onboarding, before createWorkspace), the import
  // is a no-op and notes are picked up on the next scan once the workspace
  // exists. See importVaultProjects.
  try {
    importVaultProjects(db, workspacePath, workspaceId);
  } catch (err) {
    console.error("[sync] importVaultProjects failed:", err);
  }
  syncDir(db, root, workspacePath, readImportConfig(workspacePath));
  // Persist the adoption ledger entries recorded during this scan (one config
  // write for the whole scan, not one per adopted note).
  flushAdoptedLedger(workspacePath);
}

/**
 * Resolve the set of folder slugs already owned by a LIVE (non-archived)
 * project. Shared by importVaultProjects (to decide which folders still need a
 * project) and adoptExternalNoteFile (to resolve a file's owning project) so the
 * two can never disagree about what "already exists" — a divergence there would
 * let a folder whose slug matches an ARCHIVED project be skipped by the import
 * yet fail adoption, silently dropping every note in it.
 */
function activeProjectsBySlug(
  db: Database.Database,
): Map<string, { id: string; name: string; workspace_id: string }> {
  const rows = db.prepare(
    "SELECT id, name, workspace_id FROM projects WHERE archived_at IS NULL",
  ).all() as { id: string; name: string; workspace_id: string }[];
  const bySlug = new Map<string, { id: string; name: string; workspace_id: string }>();
  for (const r of rows) {
    // First writer wins on a slug collision (stable, arbitrary but deterministic).
    const slug = toSlug(r.name);
    if (!bySlug.has(slug)) bySlug.set(slug, r);
  }
  return bySlug;
}

/**
 * Discover projects from folders on disk and create them in the DB.
 *
 * Cairn stores each project's notes under `<workspace>/<toSlug(project.name)>/`.
 * Historically the scan could only import a `.md` file if a project with the
 * matching folder slug already existed — so pointing Cairn at an Obsidian vault
 * (or copying a folder of notes in) imported nothing, because no project rows
 * existed for those folders.
 *
 * This pass closes that gap. For the resolved workspace it will:
 *
 *   1. Create a project for every top-level folder that contains at least one
 *      `.md` file (recursively), UNLESS a LIVE project with that slug already
 *      exists. The project's name is the folder's on-disk name.
 *   2. Create a single catch-all project (named after the workspace/vault
 *      folder) for loose `.md` files that live directly in the vault root, if
 *      any exist and no project already owns the root slug.
 *
 * Skips dot-directories (`.obsidian`, `.git`, `.trash`) and the known
 * infrastructure folders (`assets`, `attachments`). Idempotent — folders that
 * already map to a project are left untouched, so it is safe to run on every
 * boot and inside the file watcher.
 *
 * `workspaceId` — the workspace the discovered projects belong to. Callers that
 * know the active workspace (rescan IPC, file watcher) should pass it so that in
 * a multi-workspace install the projects attach to the RIGHT workspace, not just
 * the oldest. When omitted (first-run onboarding, where exactly one workspace
 * exists) it falls back to the oldest workspace.
 *
 * Returns the number of projects created.
 */
export function importVaultProjects(
  db: Database.Database,
  workspacePath: string,
  workspaceId?: string,
): number {
  const root = notesDir(workspacePath);
  if (!fs.existsSync(root)) return 0;
  // A rolled-back (un-managed) vault never re-creates projects from its folders.
  if (readImportConfig(workspacePath).unmanaged) return 0;

  // Resolve the workspace to attach new projects to. Prefer the caller-supplied
  // id; otherwise fall back to the oldest (primary) workspace. If none exists yet
  // (onboarding runs the first scan BEFORE createWorkspace), we can't create
  // projects — bail; the next scan after the workspace exists picks it all up.
  let wsId = workspaceId;
  if (!wsId) {
    const wsRow = db.prepare(
      "SELECT id FROM workspaces ORDER BY created_at LIMIT 1",
    ).get() as { id?: string } | undefined;
    wsId = wsRow?.id;
  } else {
    // Validate the supplied id actually exists (defensive — a stale id would
    // create orphaned projects). Fall back to oldest if not.
    const exists = db.prepare("SELECT 1 FROM workspaces WHERE id = ?").get(wsId);
    if (!exists) {
      const wsRow = db.prepare(
        "SELECT id FROM workspaces ORDER BY created_at LIMIT 1",
      ).get() as { id?: string } | undefined;
      wsId = wsRow?.id;
    }
  }
  if (!wsId) return 0;

  const excludedFolders = readImportExclusions(workspacePath);
  // A malformed import config with no known-good value halts project discovery
  // rather than adopting folders the user may have excluded. Reading the
  // exclusions above is what registers the halted state.
  if (isImportConfigHalted(workspacePath)) return 0;
  // Live-project slugs only — must match adoptExternalNoteFile's resolution set.
  const existingSlugs = new Set(activeProjectsBySlug(db).keys());

  let created = 0;
  let hasLooseRootMd = false;
  let entries: string[];
  try {
    entries = fs.readdirSync(root);
  } catch {
    return 0;
  }

  for (const entry of entries) {
    if (entry.startsWith(".")) continue; // .obsidian, .git, .trash, etc.
    const fp = path.join(root, entry);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(fp);
    } catch {
      continue;
    }

    if (stat.isDirectory()) {
      if (isSkippedDirectory(entry) || excludedFolders.has(entry)) continue;
      // Legacy `notes/` handling mirrors syncDir: only treat it as a project
      // folder when it's part of an Obsidian vault or has direct .md files.
      if (entry === "notes" && !isImportableNotesFolder(workspacePath)) continue;
      const slug = toSlug(entry);
      // Slug check BEFORE the (recursive) dirHasMarkdown walk: a folder that
      // already maps to a project must not pay for a full subtree scan on every
      // boot / file-add event.
      if (existingSlugs.has(slug)) continue;
      if (!dirHasMarkdown(fp)) continue; // empty of notes — not a project
      ensureProject(db, wsId, entry);
      existingSlugs.add(slug);
      created++;
    } else if (!isSkippedMarkdown(entry)) {
      hasLooseRootMd = true;
    }
  }

  // Loose .md files directly in the vault root → catch-all project named after
  // the vault folder. Only create it if such files exist and no project already
  // claims the root slug. (If a top-level folder already slugs to the vault name,
  // its project owns the slug and the loose files fold into it — documented in
  // docs/obsidian-vaults.md.)
  if (hasLooseRootMd) {
    const vaultName = path.basename(root) || "Notes";
    const slug = toSlug(vaultName);
    if (!existingSlugs.has(slug)) {
      ensureProject(db, wsId, vaultName);
      existingSlugs.add(slug);
      created++;
    }
  }

  return created;
}

/** True if a root `notes/` folder should be scanned as a project (vault or has direct .md). */
function isImportableNotesFolder(workspacePath: string): boolean {
  if (fs.existsSync(path.join(workspacePath, ".obsidian"))) return true;
  const notesPath = path.join(workspacePath, "notes");
  try {
    return fs.readdirSync(notesPath).some(
      (e) => e.endsWith(".md") && fs.lstatSync(path.join(notesPath, e)).isFile(),
    );
  } catch {
    return false;
  }
}

/** Recursively test whether `dir` contains at least one `.md` file (ignoring dot-dirs). */
function dirHasMarkdown(dir: string): boolean {
  let items: string[];
  try {
    items = fs.readdirSync(dir);
  } catch {
    return false;
  }
  for (const item of items) {
    if (isSkippedDirectory(item)) continue;
    const fp = path.join(dir, item);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(fp);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (dirHasMarkdown(fp)) return true;
    } else if (!isSkippedMarkdown(item)) {
      return true;
    }
  }
  return false;
}

/**
 * Create a project (plus the default board columns) named `name` in `workspaceId`.
 * Returns the new project id. Callers are responsible for slug-uniqueness checks.
 *
 * The project row + all default columns are created in a single transaction, so
 * a failure partway through can never leave a project with a partial/empty board
 * (mirrors the db:project:create handler).
 */
export function ensureProject(db: Database.Database, workspaceId: string, name: string): string {
  const projectId = newId();
  db.transaction(() => {
    q.createProject(db, { id: projectId, workspaceId, name });
    for (const col of DEFAULT_COLUMNS) {
      q.createColumn(db, {
        id: newId(),
        projectId,
        workspaceId,
        name: col.name,
        type: col.type,
        order: col.order,
      });
    }
  })();
  console.log(`[sync] Auto-created project "${name}" from vault folder.`);
  return projectId;
}

/**
 * Reconcile project note directories on disk with current project names.
 *
 * A project's on-disk folder is derived from `toSlug(project.name)`. Renaming a
 * project used to update only the DB, leaving the `.md` files stranded under the
 * OLD slug (e.g. "Test Project" renamed to "Misc" but files still in
 * `<ws>/Test Project/`). Going forward, renames relocate the folder live (see
 * renameProjectNotesDir wired into the project-update handlers), but this heals
 * workspaces where a rename already happened before that fix.
 *
 * Strategy (name-agnostic — we don't need to know the old name):
 *   1. Map each top-level directory to the project that owns its notes, by
 *      reading the `projectId` from the first Cairn `.md` file found inside.
 *   2. If that directory's name != the project's expected slug, move it to the
 *      expected directory (merging if one already exists). Runs before
 *      syncNotesFromDisk so the relocated files are then imported/updated
 *      from their correct location.
 *
 * Idempotent and best-effort: a workspace already in sync is a no-op, and any
 * per-project failure is logged and skipped without aborting the others.
 * Returns the number of directories relocated.
 */
export function reconcileProjectFolders(db: Database.Database, workspacePath: string): number {
  const root = notesDir(workspacePath);
  if (!fs.existsSync(root)) return 0;

  // Expected slug → project name, for every project in the DB.
  const projects = q.getProjects(db) as { id: string; name: string }[];
  const expectedSlugById = new Map(projects.map((p) => [p.id, toSlug(p.name)]));
  const nameById = new Map(projects.map((p) => [p.id, p.name]));

  let moved = 0;
  let entries: string[];
  try {
    entries = fs.readdirSync(root);
  } catch {
    return 0;
  }

  for (const entry of entries) {
    if (entry.startsWith(".")) continue; // .obsidian, .git, .cairn-migrations.json
    const dir = path.join(root, entry);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(dir);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;

    // Identify which project this directory belongs to via a contained note.
    const ownerProjectId = firstNoteProjectId(dir);
    if (!ownerProjectId) continue; // no Cairn notes here — not a project folder
    const expectedSlug = expectedSlugById.get(ownerProjectId);
    if (!expectedSlug || expectedSlug === entry) continue; // already correct

    const projectName = nameById.get(ownerProjectId)!;
    try {
      // renameProjectNotesDir works in terms of project NAMES → slugs; feed it
      // this directory's literal name as the "old name" and the project's real
      // name as the "new name" so it computes old=<entry> → new=<expectedSlug>.
      if (renameProjectNotesDir(workspacePath, entry, projectName)) {
        moved++;
        console.log(`[reconcile] Moved project notes "${entry}" → "${expectedSlug}" (project "${projectName}").`);
      }
    } catch (err) {
      console.error(`[reconcile] Failed to relocate "${entry}":`, err);
    }
  }
  return moved;
}

/** Read the `projectId` from the first Cairn `.md` file found under `dir` (recursive). */
function firstNoteProjectId(dir: string): string | null {
  let found: string | null = null;
  const walk = (d: string) => {
    if (found) return;
    let items: string[];
    try {
      items = fs.readdirSync(d);
    } catch {
      return;
    }
    for (const item of items) {
      if (found) return;
      if (item.startsWith(".")) continue;
      const fp = path.join(d, item);
      let st: fs.Stats;
      try {
        st = fs.lstatSync(fp);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(fp);
      } else if (item.endsWith(".md")) {
        const note = parseNoteFile(fp);
        if (note?.projectId) {
          found = note.projectId;
          return;
        }
      }
    }
  };
  walk(dir);
  return found;
}

/** Remove any *.md.tmp files left by a crash during an atomic write. */
function cleanStaleTmpFiles(dir: string): void {
  try {
    for (const entry of fs.readdirSync(dir)) {
      const fp = path.join(dir, entry);
      try {
        const stat = fs.lstatSync(fp);
        if (stat.isDirectory()) {
          cleanStaleTmpFiles(fp);
        } else if (entry.endsWith(".md.tmp")) {
          fs.unlinkSync(fp);
        }
      } catch { /* skip unreadable entries */ }
    }
  } catch { /* root unreadable */ }
}

function syncDir(db: Database.Database, dir: string, workspacePath: string, config: ImportConfig): void {
  for (const entry of fs.readdirSync(dir)) {
    // Skip dot-prefixed directories (.obsidian, .trash, .git, etc.)
    if (isSkippedDirectory(entry)) continue;
    if (dir === workspacePath && config.excludedFolders.includes(entry)) continue;

    if (entry === "notes" && dir === workspacePath) {
      // If it's already an Obsidian vault (contains a .obsidian folder at root), do NOT skip notes/
      if (fs.existsSync(path.join(workspacePath, ".obsidian"))) {
        // Continue scanning notes/
      } else {
        // Skip only if it's a legacy notes/ directory (no direct .md files)
        const notesPath = path.join(workspacePath, "notes");
        try {
          const entries = fs.readdirSync(notesPath);
          const hasDirectMd = entries.some((e) => e.endsWith(".md") && fs.lstatSync(path.join(notesPath, e)).isFile());
          if (!hasDirectMd) {
            continue;
          }
        } catch {
          continue;
        }
      }
    }

    const fp = path.join(dir, entry);
    const stat = fs.lstatSync(fp);
    if (stat.isDirectory()) {
      syncDir(db, fp, workspacePath, config);
    } else if (!isSkippedMarkdown(entry)) {
      let note = parseNoteFile(fp);
      // Plain .md without Cairn frontmatter — adopt it in-place
      if (!note) note = adoptExternalNoteFile(db, workspacePath, fp);
      if (!note) continue;
      reconcileOwnedNote(db, workspacePath, fp, note, config);
    }
  }
}

/**
 * Reconcile an owned note file against its DB row.
 *
 * Re-import 3-way check (when the ledger has a baseline for this note): the
 * adopted body hash is the "last time both sides agreed" baseline. File-only
 * changed → adopt the file. BOTH sides changed since then and disagree → keep
 * the on-disk (vault) file as current and preserve Cairn's version as a
 * conflict copy. External unchanged → keep the row (never clobber the file).
 * No baseline (a note adopted before the ledger existed, or a Cairn-created
 * note) → fall back to the timestamp heuristic.
 *
 * Shared by the scan (`syncDir`) and the file watcher so live external edits
 * get the same treatment as a re-scan.
 */
export function reconcileOwnedNote(
  db: Database.Database,
  workspacePath: string,
  filePath: string,
  note: NoteData,
  config: ImportConfig,
): void {
  const row = db.prepare("SELECT id, title, content, updated_at FROM notes WHERE id = ?")
    .get(note.id) as { id: string; title: string; content: string | null; updated_at: string } | undefined;

  if (!row) {
    // Missing from SQLite — always import
    upsertNoteFromFile(db, note);
    return;
  }

  const adoptedHash = config.adopted[note.id]?.bodyHash;
  if (!adoptedHash) {
    // Compare timestamps: import if file is demonstrably newer than DB row.
    // Primary: frontmatter updatedAt (written by Cairn on every save).
    const fileTs = new Date(note.updatedAt ?? note.createdAt).getTime();
    const dbTs   = new Date(row.updated_at).getTime();
    if (fileTs > dbTs) {
      upsertNoteFromFile(db, note);
      return;
    }
    // Fallback: if frontmatter timestamp didn't change (external editor edited
    // the body without touching frontmatter), use file mtime. 2-second buffer
    // avoids spurious overwrites from FS precision drift.
    let fileMtime = 0;
    try { fileMtime = fs.lstatSync(filePath).mtimeMs; } catch { return; }
    if (fileMtime > dbTs + 2000) {
      upsertNoteFromFile(db, note);
    }
    return;
  }

  const fileHash = bodyHash(note.content ?? "");
  const rowHash = bodyHash(row.content ?? "");
  const externalChanged = fileHash !== adoptedHash;
  const cairnChanged = rowHash !== adoptedHash;
  if (externalChanged && cairnChanged && fileHash !== rowHash) {
    // Edited in BOTH the vault file and Cairn since they last agreed → keep the
    // vault file as current, preserve Cairn's version as a conflict copy.
    mintImportConflictCopy(db, row);
    upsertNoteFromFile(db, note);
    touchAdoptedBaseline(workspacePath, note.id, note.content ?? "");
  } else if (externalChanged) {
    // Only the external file changed → the vault is the source of truth.
    upsertNoteFromFile(db, note);
    touchAdoptedBaseline(workspacePath, note.id, note.content ?? "");
  }
  // else: external unchanged → row stands; the file is not rewritten.
}

/**
 * Mint a conflict copy of a note whose body was edited BOTH in Cairn and in the
 * vault file since adoption. Mirrors the sync engine's conflict-copy convention
 * (`_conflict_<origin>_<ts>` id + " (conflicted copy — …)" title suffix) so the
 * copy surfaces automatically in the existing conflict-resolution UI.
 *
 * The copy is a DB-only clone (no `.md` projected until the user resolves it):
 * resolution writes the file for "keep copy", and "keep original" deletes a
 * missing file as a no-op. The on-disk (vault) file remains the note's current
 * source.
 */
function mintImportConflictCopy(
  db: Database.Database,
  row: { id: string; title: string },
): void {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const copyId = `${row.id}_conflict_import_${suffix}`;
  const copyTitle = `${row.title} (conflicted copy — import)`;
  try {
    db.prepare(
      `INSERT INTO notes (id, project_id, workspace_id, title, content, content_text, tag_ids, linked_note_ids, linked_card_ids, is_pinned, type, created_at, updated_at, archived_at, hlc, deleted_at, version)
       SELECT ?, project_id, workspace_id, ?, content, content_text, tag_ids, linked_note_ids, linked_card_ids, is_pinned, type, created_at, updated_at, NULL, NULL, NULL, 0
       FROM notes WHERE id = ? AND deleted_at IS NULL`,
    ).run(copyId, copyTitle, row.id);
  } catch (err) {
    console.error("[import] failed to mint conflict copy:", err);
  }
}
// ── Upsert a parsed note into SQLite ──────────
//
// Uses INSERT OR IGNORE + UPDATE to avoid UNIQUE constraint errors when the
// file watcher fires on a file that was just written by the app itself.
// The SELECT+INSERT pattern had a race window; this is fully atomic.

/**
 * Attempt to adopt a plain .md file that was dropped into a project folder
 * from outside the app (no Cairn frontmatter).
 *
 * Resolves the project by matching the first path segment under `notes/` to a
 * project slug in the database. If a matching project is found, generates a new
 * note ID, writes Cairn frontmatter back to the file, then upserts into SQLite.
 *
 * Returns the adopted NoteData on success, or null if the file can't be adopted
 * (e.g. not inside a known project folder, or the file is unreadable).
 */
export function adoptExternalNoteFile(
  db: Database.Database,
  workspacePath: string,
  filePath: string,
): NoteData | null {
  try {
    const root = notesDir(workspacePath);
    const rel  = path.relative(root, filePath); // e.g. "my-project/sub/Note Title.md"
    const segments = rel.split(path.sep);
    if (segments.length < 1) return null;
    if (isImportPathExcluded(workspacePath, filePath)) return null;

    // A file directly in the vault root (segments === ["Note.md"]) has no owning
    // folder. It belongs to the catch-all project named after the vault folder
    // (created by importVaultProjects). Anything deeper is owned by its
    // top-level folder.
    const isRootFile = segments.length === 1;
    const projectSlug = isRootFile ? toSlug(path.basename(root) || "Notes") : segments[0];

    // Resolve the owning project via the SAME live-project slug map that
    // importVaultProjects uses — so a folder the import created (or skipped
    // because a live project already owns the slug) always resolves here, and
    // an ARCHIVED project's slug never shadows a real folder.
    const project = activeProjectsBySlug(db).get(projectSlug);
    if (!project) return null;

    // Read file content and any existing frontmatter (Obsidian fields, etc.)
    const raw = fs.readFileSync(filePath, "utf-8");
    const { data: existingData, content } = matter(raw);

    // Title resolution: prefer existing frontmatter title (Obsidian convention),
    // then fall back to filename (strip .md extension).
    const filename = segments[segments.length - 1];
    const title = (typeof existingData.title === "string" && existingData.title.length > 0)
      ? existingData.title
      : path.basename(filename, ".md");

    // Derive subfolder from intermediate path segments (un-slugged as-is)
    const folderSegments = segments.slice(1, -1);
    const folder = folderSegments.join("/");

    const now  = new Date().toISOString();
    const id   = newId();

    // Resolve Obsidian tags → Cairn tag records
    let tagIds: string[] = [];
    if (Array.isArray(existingData.tags) && existingData.tags.length > 0) {
      tagIds = resolveObsidianTagsToCairn(db, project.workspace_id, existingData.tags as string[]);
    }

    const note: NoteData = {
      id,
      projectId:     project.id,
      workspaceId:   project.workspace_id,
      title,
      content,
      tagIds,
      linkedNoteIds: [],
      linkedCardIds: [],
      isPinned:      false,
      folder,
      createdAt:     now,
      updatedAt:     now,
      projectName:   project.name,
    };

    // Write Cairn frontmatter back IN-PLACE to the original file path.
    // We must NOT use writeNoteFile() here — that function resolves a new
    // slug-based path from the title, which would create a second file and
    // leave the original orphaned with no frontmatter.
    //
    // MERGE strategy: preserve all non-Cairn frontmatter keys (Obsidian
    // tags, aliases, cssclass, date, publish, custom properties, etc.)
    const existingExtra: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(existingData)) {
      if (!CAIRN_FRONTMATTER_KEYS.has(key)) {
        existingExtra[key] = value;
      }
    }

    const cairnFields: Record<string, unknown> = {
      id,
      projectId:     project.id,
      workspaceId:   project.workspace_id,
      title,
      folder,
      tagIds,
      linkedNoteIds: [],
      linkedCardIds: [],
      isPinned:      false,
      createdAt:     now,
      updatedAt:     now,
    };

    // Non-Cairn keys first, then Cairn keys on top (Cairn always wins on conflict)
    const mergedFrontmatter = { ...existingExtra, ...cairnFields };
    fs.writeFileSync(filePath, matter.stringify(content, mergedFrontmatter), "utf-8");

    // Record the adoption in the workspace ledger (flushed once per scan by
    // flushAdoptedLedger) so a later re-scan has the body baseline for the
    // 3-way conflict check. Hash the body AS ROUND-TRIPPED through the file
    // (matter.stringify normalises it — trailing newline, etc.), so a re-scan
    // of the freshly-written file sees an unchanged baseline instead of a
    // spurious "external edit".
    const canonical = parseNoteFile(filePath);
    recordAdoption(workspacePath, id, rel, canonical?.content ?? content);

    return note;
  } catch {
    return null;
  }
}

/**
 * Resolve Obsidian tag names to Cairn tag IDs.
 * Creates new tag records in the DB for any tag names that don't already exist.
 */
function resolveObsidianTagsToCairn(
  db: Database.Database,
  workspaceId: string,
  tagNames: string[],
): string[] {
  const resolvedIds: string[] = [];
  for (const rawName of tagNames) {
    const name = String(rawName).trim();
    if (!name) continue;
    const existing = db.prepare(
      "SELECT id FROM tags WHERE workspace_id = ? AND LOWER(name) = ?",
    ).get(workspaceId, name.toLowerCase()) as { id: string } | undefined;
    if (existing) {
      resolvedIds.push(existing.id);
    } else {
      const newTagId = newId();
      db.prepare(
        "INSERT INTO tags (id, workspace_id, name, color) VALUES (?, ?, ?, ?)",
      ).run(newTagId, workspaceId, name, "#6366f1");
      resolvedIds.push(newTagId);
    }
  }
  return resolvedIds;
}

export function upsertNoteFromFile(db: Database.Database, note: NoteData): void {
  // Only upsert if the referenced project exists
  const project = db.prepare("SELECT id FROM projects WHERE id = ?").get(note.projectId);
  if (!project) return;

  const now = note.updatedAt ?? new Date().toISOString();
  const contentText = stripMarkdown(note.content);

  // INSERT OR IGNORE — no-op if the row already exists (avoids UNIQUE error)
  db.prepare(`
    INSERT OR IGNORE INTO notes
      (id, project_id, workspace_id, title, content, content_text,
       tag_ids, linked_note_ids, linked_card_ids, is_pinned, type,
       folder, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, '[]', '[]', 0, 'note', ?, ?, ?)
  `).run(
    note.id, note.projectId, note.workspaceId,
    note.title, note.content, contentText,
    JSON.stringify(note.tagIds ?? []),
    note.folder ?? "",
    note.createdAt ?? now, now,
  );

  // Always UPDATE — brings both new and existing rows up to date
  q.updateNote(db, note.id, {
    title: note.title,
    content: note.content,
    contentText,
    tagIds: note.tagIds,
    linkedNoteIds: note.linkedNoteIds,
    linkedCardIds: note.linkedCardIds,
    isPinned: note.isPinned,
    folder: note.folder,
    archivedAt: note.archivedAt,
  });
}
