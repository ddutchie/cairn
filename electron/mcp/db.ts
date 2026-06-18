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
  const candidates = [
    path.join(execDir, "better_sqlite3.node"),
    path.join(__dirname, "..", "pkg-native", "better_sqlite3.node"),
    path.join(__dirname, "..", "..", "pkg-native", "better_sqlite3.node"),
  ];
  return candidates.find((p) => fs.existsSync(p));
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

export function findDbPathFromWorkspaceConfig(): string | null {
  const base = getConfigBasePath();
  const names = ["Cairn", "cairn", "Electron"];
  for (const name of names) {
    const configPath = path.join(base, name, "workspace-config.json");
    if (!fs.existsSync(configPath)) continue;
    try {
      const raw = fs.readFileSync(configPath, "utf-8");
      const config = JSON.parse(raw) as { workspacePath?: string };
      if (typeof config.workspacePath === "string" && config.workspacePath.length > 0) {
        const dbPath = path.join(config.workspacePath, "cairn.db");
        if (fs.existsSync(dbPath)) return dbPath;
      }
    } catch { /* ignore */ }
  }
  return null;
}

export function findDbPath(): string | null {
  const fromConfig = findDbPathFromWorkspaceConfig();
  if (fromConfig) return fromConfig;

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
  const base = getConfigBasePath();
  for (const name of ["Cairn", "cairn", "Electron"]) {
    const configPath = path.join(base, name, "workspace-config.json");
    if (!fs.existsSync(configPath)) continue;
    try {
      const cfg = JSON.parse(fs.readFileSync(configPath, "utf-8")) as { workspacePath?: string };
      if (typeof cfg.workspacePath === "string" && cfg.workspacePath.length > 0) {
        return cfg.workspacePath;
      }
    } catch { /* ignore */ }
  }
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

export function insertNotification(db: Database.Database, tool: string, title: string, body: string): void {
  try {
    const id = newId();
    db.prepare(
      "INSERT INTO mcp_notifications (id, tool, title, body, read, created_at) VALUES (?, ?, ?, ?, 0, ?)"
    ).run(id, tool, title, body, ts());
  } catch {
    // best-effort
  }
}
