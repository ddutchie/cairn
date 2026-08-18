import path from "path";
import os from "os";
import fs from "fs";
import Database from "better-sqlite3";
import { toWorkspace, toProject, toNote, toColumn, toCard, toTag, j, j2, p, b } from "../shared/db-mappers";
import { projectNotesDir, findNoteFilePath, resolveNoteFilePath, writeNoteFile, deleteNoteFile } from "../shared/notes-io";
import { newId, ts } from "../db/utils";
import * as q from "../db/queries";

export {
  toWorkspace,
  toProject,
  toNote,
  toColumn,
  toCard,
  toTag,
  j,
  j2,
  p,
  b,
  projectNotesDir,
  findNoteFilePath,
  resolveNoteFilePath,
  writeNoteFile,
  deleteNoteFile
};

// ── Native Binding Resolver ───────────────────

export function resolveMcpNativeBinding(): string | undefined {
  const execDir = path.dirname(process.execPath);
  const arch = process.arch;

  // Inside the packaged (pkg) binary, `__dirname` is a virtual `/snapshot/…`
  // path. A native .node addon CANNOT be loaded from pkg's virtual filesystem —
  // and worse, `fs.existsSync` returns TRUE for an embedded `/snapshot` path, so
  // returning it as `nativeBinding` makes better-sqlite3 `require()` it and the
  // binary crashes at startup. When packaged we therefore consider ONLY real
  // on-disk paths next to the executable (the arch-matched sidecar staged by
  // build-mcp-binary.js). In dev we use the arch-separated pkg-native prebuilds.
  const inPkg = Boolean((process as unknown as { pkg?: unknown }).pkg);

  const candidates = inPkg
    ? [
        // Packaged: real sidecar next to the executable, by arch, then flat.
        path.join(execDir, `better_sqlite3-${arch}.node`),
        path.join(execDir, "better_sqlite3.node"),
      ]
    : [
        // Dev / bundled runtime — arch-separated prebuilds, then legacy flat.
        path.join(__dirname, "..", "pkg-native", arch, "better_sqlite3.node"),
        path.join(__dirname, "..", "..", "pkg-native", arch, "better_sqlite3.node"),
        path.join(__dirname, "..", "pkg-native", "better_sqlite3.node"),
        path.join(__dirname, "..", "..", "pkg-native", "better_sqlite3.node"),
      ];

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      /* unreadable — keep looking */
    }
  }
  return undefined;
}

export const MCP_NATIVE_BINDING = resolveMcpNativeBinding();

// ── Config & DB Resolution ─────────────────────

export function getConfigBasePath(): string {
  const home = os.homedir();
  const platform = process.platform;
  if (platform === "win32") {
    return process.env.APPDATA ?? path.join(home, "AppData", "Roaming");
  } else if (platform === "darwin") {
    return path.join(home, "Library", "Application Support");
  } else {
    return process.env.XDG_CONFIG_HOME ?? path.join(home, ".config");
  }
}

/**
 * Candidate Electron userData directory names, in *most-recently-written* order.
 *
 * A machine can legitimately have several: `Cairn` (packaged app), `cairn`, and
 * `Electron` (dev — Electron's default userData name when productName isn't
 * applied). A fixed probe order silently binds the MCP to whichever one happens
 * to come first in the list, which is how a dev session could end up reading the
 * *packaged* app's workspace (and vice versa). Ordering by the config file's
 * mtime instead means we follow whichever Cairn the user actually used last.
 */
function configCandidatesByRecency(): string[] {
  const base = getConfigBasePath();
  return ["Cairn", "cairn", "Electron"]
    .map((name) => {
      const configPath = path.join(base, name, "workspace-config.json");
      let mtime = -1;
      try { mtime = fs.statSync(configPath).mtimeMs; } catch { /* absent */ }
      return { configPath, mtime };
    })
    .filter((c) => c.mtime >= 0)
    .sort((a, b) => b.mtime - a.mtime)
    .map((c) => c.configPath);
}

function readWorkspacePathFromConfig(configPath: string): string | null {
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath, "utf-8")) as { workspacePath?: string };
    if (typeof cfg.workspacePath === "string" && cfg.workspacePath.length > 0) {
      return cfg.workspacePath;
    }
  } catch { /* unreadable / malformed */ }
  return null;
}

/**
 * Explicit override: `CAIRN_DB_PATH=/path/to/cairn.db`.
 *
 * Lets an agent host (or a test) pin the MCP to a specific workspace instead of
 * inferring it from the app's config, which matters because the standalone
 * binary is expected to run while Cairn is closed.
 */
function dbPathFromEnv(): string | null {
  const raw = process.env.CAIRN_DB_PATH?.trim();
  if (!raw) return null;
  // Accept either the db file itself or the workspace folder containing it.
  const candidates = [raw, path.join(raw, "cairn.db")];
  for (const c of candidates) {
    try { if (fs.statSync(c).isFile()) return c; } catch { /* keep looking */ }
  }
  return null;
}

export function findDbPathFromWorkspaceConfig(): string | null {
  const resolved = resolveWorkspaceFromConfig();
  return resolved ? resolved.dbPath : null;
}

/**
 * Select the single config candidate whose `workspacePath` is non-empty AND
 * whose `cairn.db` exists, in recency order. Returns both the db path and the
 * workspace folder so `findDbPath` and `findWorkspacePath` can never diverge
 * (previously `findWorkspacePath` accepted the first non-empty `workspacePath`
 * even if its db was missing, while `findDbPath` skipped to an older candidate —
 * so note writes could land in a different folder than the db being read).
 */
function resolveWorkspaceFromConfig(): { dbPath: string; workspacePath: string } | null {
  for (const configPath of configCandidatesByRecency()) {
    const workspacePath = readWorkspacePathFromConfig(configPath);
    if (!workspacePath) continue;
    const dbPath = path.join(workspacePath, "cairn.db");
    if (fs.existsSync(dbPath)) return { dbPath, workspacePath };
  }
  return null;
}

export function findDbPath(): string | null {
  const fromEnv = dbPathFromEnv();
  if (fromEnv) return fromEnv;

  const fromConfig = resolveWorkspaceFromConfig();
  if (fromConfig) return fromConfig.dbPath;

  const base = getConfigBasePath();
  const names = ["Cairn", "cairn", "Electron"];
  let best: string | null = null;
  let bestCount = -1;

  for (const name of names) {
    const p = path.join(base, name, "cairn", "cairn.db");
    if (!fs.existsSync(p)) continue;
    try {
      const db = new Database(p, { readonly: true, ...(MCP_NATIVE_BINDING ? { nativeBinding: MCP_NATIVE_BINDING } : {}) });
      const row = db.prepare("SELECT COUNT(*) as cnt FROM workspaces").get() as { cnt: number };
      db.close();
      if (row.cnt > bestCount) {
        bestCount = row.cnt;
        best = p;
      }
    } catch { /* skip corrupt/incompatible */ }
  }

  return best;
}

export function findWorkspacePath(dbPath: string): string {
  // An explicit CAIRN_DB_PATH wins — its containing folder IS the workspace, and
  // deferring to a config file here would point note writes somewhere else.
  if (dbPathFromEnv()) return path.dirname(dbPath);

  // Use the SAME candidate the db was resolved from (both non-empty workspacePath
  // and an existing cairn.db) so the workspace folder and the db never diverge.
  const resolved = resolveWorkspaceFromConfig();
  if (resolved) return resolved.workspacePath;

  // Legacy fallback (findDbPath's workspace-count scan): the db path has no
  // config-declared folder, so the workspace is the db's own directory.
  return path.dirname(dbPath);
}

// ── Snapshot ──────────────────────────────────

export interface Snapshot {
  workspaces: ReturnType<typeof toWorkspace>[];
  projects: ReturnType<typeof toProject>[];
  notes: ReturnType<typeof toNote>[];
  columns: ReturnType<typeof toColumn>[];
  cards: ReturnType<typeof toCard>[];
  // toTag returns { id, workspaceId, name, color } — same 4-field shape every
  // consumer currently uses. The previous local definition only declared those
  // four fields explicitly; aliased here so the source of truth is one place.
  tags: ReturnType<typeof toTag>[];
}

export function getSnapshot(db: Database.Database): Snapshot {
  // Delegate to q.getFullSnapshot — the canonical implementation in queries.ts.
  // Returns the same shape (workspaces/projects/notes/columns/cards/tags via the
  // shared toX mappers) — the previous local getSnapshot reimplemented the same
  // six SELECTs + mappers inline (~14 LOC of duplication).
  return q.getFullSnapshot(db);
}

// ── Locks & Notifications ──────────────────────

export function ensureMcpActiveWritesTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS mcp_active_writes (
      note_id    TEXT NOT NULL PRIMARY KEY,
      started_at TEXT NOT NULL
    );
  `);
  db.prepare("DELETE FROM mcp_active_writes WHERE started_at < datetime('now', '-30 seconds')").run();
}

export function ensureEmbeddingsTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS note_embeddings (
      note_id        TEXT PRIMARY KEY REFERENCES notes(id) ON DELETE CASCADE,
      workspace_id   TEXT NOT NULL,
      model          TEXT NOT NULL,
      task           TEXT NOT NULL,
      content_hash   TEXT NOT NULL,
      vector         TEXT NOT NULL,
      embedded_at    TEXT NOT NULL,
      dim_x          REAL,
      dim_y          REAL,
      proj_stale     INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS idx_emb_workspace ON note_embeddings(workspace_id);
    CREATE INDEX IF NOT EXISTS idx_emb_proj_stale ON note_embeddings(proj_stale);
    CREATE INDEX IF NOT EXISTS idx_emb_task ON note_embeddings(task);
  `);
}

export function lockNote(db: Database.Database, noteId: string): void {
  try {
    db.prepare("INSERT OR REPLACE INTO mcp_active_writes (note_id, started_at) VALUES (?, datetime('now'))").run(noteId);
  } catch { /* best-effort */ }
}

export function unlockNote(db: Database.Database, noteId: string): void {
  try {
    db.prepare("DELETE FROM mcp_active_writes WHERE note_id = ?").run(noteId);
  } catch { /* best-effort */ }
}

export function getNoteVersion(db: Database.Database, noteId: string): number | null {
  try {
    const row = db.prepare("SELECT version FROM notes WHERE id = ?").get(noteId) as { version: number } | undefined;
    return row?.version ?? null;
  } catch {
    return null;
  }
}

export function getCardVersion(db: Database.Database, cardId: string): number | null {
  try {
    const row = db.prepare("SELECT version FROM task_cards WHERE id = ?").get(cardId) as { version: number } | undefined;
    return row?.version ?? null;
  } catch {
    return null;
  }
}

export function resolveTagNames(db: Database.Database, workspaceId: string, tagNames?: string[]): string[] {
  if (!Array.isArray(tagNames) || tagNames.length === 0) return [];
  const resolvedIds: string[] = [];
  for (const rawName of tagNames) {
    const name = rawName.trim();
    if (!name) continue;
    const existing = db.prepare("SELECT id FROM tags WHERE workspace_id = ? AND LOWER(name) = ?")
      .get(workspaceId, name.toLowerCase()) as { id: string } | undefined;
    if (existing) {
      resolvedIds.push(existing.id);
    } else {
      const newTagId = newId();
      db.prepare("INSERT INTO tags (id, workspace_id, name, color) VALUES (?, ?, ?, ?)")
        .run(newTagId, workspaceId, name, "#6366f1");
      resolvedIds.push(newTagId);
    }
  }
  return resolvedIds;
}

export function insertNotification(
  db: Database.Database,
  tool: string,
  title: string,
  body: string,
  target?: { type: "note" | "task" | "automation" | "approval"; id: string } | null,
): void {
  try {
    const id = newId();
    db.prepare(
      "INSERT INTO mcp_notifications (id, tool, title, body, read, created_at, target_type, target_id) VALUES (?, ?, ?, ?, 0, ?, ?, ?)"
    ).run(id, tool, title, body, ts(), target?.type ?? null, target?.id ?? null);
  } catch {
    // best-effort
  }
}
