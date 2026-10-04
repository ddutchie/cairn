/**
 * Vault import configuration (`.cairn-import.json`): folder exclusions, the
 * adoption ledger used as the 3-way re-import baseline, and the unmanaged flag.
 */

import path from "path";
import fs from "fs";
import { createHash } from "crypto";
import { notesDir } from "./host-shared/notes-io";

const IMPORT_CONFIG_FILE = ".cairn-import.json";
const DEFAULT_SKIP_DIRS = new Set([
  "assets",
  "attachments",
  "templates",
  "node_modules",
  "dist",
  "build",
  "target",
  "vendor",
  "out",
  "coverage",
]);

export interface VaultImportPreview {
  isObsidianVault: boolean;
  vaultName: string;
  noteCount: number;
  skippedCount: number;
  projects: Array<{ name: string; noteCount: number; root: boolean; projectKey: string }>;
  excludedFolders: string[];
}

export function isSkippedMarkdown(name: string): boolean {
  const lower = name.toLowerCase();
  return !lower.endsWith(".md") || lower.endsWith(".md.tmp") || lower.endsWith(".excalidraw.md");
}

export function isSkippedDirectory(name: string): boolean {
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
      return { ...EMPTY_CONFIG, adopted: { ...EMPTY_CONFIG.adopted } };
    }
    const cached = lastValidConfigs.get(workspacePath);
    if (cached) return { ...cached, adopted: { ...cached.adopted } };
    haltedWorkspaces.add(workspacePath);
    return { ...EMPTY_CONFIG, adopted: { ...EMPTY_CONFIG.adopted } };
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
    // Clone `adopted` so a caller mutating the returned config can never change
    // the module-level cache entry (which rollbackImport/saveImportExclusions
    // rely on staying stable across calls).
    return { ...cfg, adopted: { ...cfg.adopted } };
  } catch {
    // Present but malformed/truncated. Never fail open: fall back to the last
    // valid config we parsed. If we never parsed a valid file, halt imports
    // for this workspace until the file is repaired.
    const cached = lastValidConfigs.get(workspacePath);
    if (cached) return { ...cached, adopted: { ...cached.adopted } };
    haltedWorkspaces.add(workspacePath);
    return { ...EMPTY_CONFIG, adopted: { ...EMPTY_CONFIG.adopted } };
  }
}

/** True when the workspace's import config is present but broken beyond the last-known-good copy. */
export function isImportConfigHalted(workspacePath: string): boolean {
  return haltedWorkspaces.has(workspacePath);
}

export function readImportExclusions(workspacePath: string): Set<string> {
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
export function writeImportConfig(workspacePath: string, cfg: ImportConfig): void {
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
  lastValidConfigs.set(workspacePath, { excludedFolders: clean, adopted: { ...cfg.adopted }, unmanaged: cfg.unmanaged });
  haltedWorkspaces.delete(workspacePath);
}

export function saveImportExclusions(workspacePath: string, excludedFolders: string[]): void {
  const current = readImportConfig(workspacePath);
  writeImportConfig(workspacePath, { ...current, excludedFolders });
}

// ── Adoption ledger (3-way re-import baseline) ────────────────────────────────

export function bodyHash(content: string): string {
  // Normalise trailing whitespace so the same note hashes identically whether
  // it came from the DB row (raw body) or a file (matter.stringify adds a
  // trailing newline) — otherwise every re-scan looks like an "external edit".
  return createHash("sha256").update((content ?? "").replace(/\s+$/, "")).digest("hex");
}

/** Pending ledger entries, merged into the config file once per scan (avoids a
 *  config rewrite for every adopted note during a bulk vault import). */
const pendingAdopted = new Map<string, Record<string, ImportAdoptedEntry>>();

export function recordAdoption(workspacePath: string, id: string, relPath: string, content: string): void {
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
