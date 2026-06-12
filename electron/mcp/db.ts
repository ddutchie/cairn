/* eslint-disable @typescript-eslint/no-explicit-any */
import path from "path";
import os from "os";
import fs from "fs";
import Database from "better-sqlite3";
import matter from "gray-matter";
import { toSlug } from "../shared/text-utils";
import { newId, ts } from "../db/utils";

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

// ── Query Parsing Helpers ──────────────────────

export function j(v: unknown): string { return JSON.stringify(v ?? []); }
export function j2(v: string | null | undefined): string[] {
  if (!v) return [];
  try { return JSON.parse(v) as string[]; } catch { return []; }
}
export function p(v: string | null | undefined): unknown[] {
  if (!v) return [];
  try { return JSON.parse(v); } catch { return []; }
}
export function b(v: number | null): boolean { return v === 1; }

// ── Mappers ───────────────────────────────────

export function toWorkspace(r: any) {
  return {
    id: r.id, name: r.name, description: r.description, icon: r.icon,
    createdAt: r.created_at, updatedAt: r.updated_at, archivedAt: r.archived_at
  };
}

export function toProject(r: any) {
  return {
    id: r.id, workspaceId: r.workspace_id, name: r.name, description: r.description,
    icon: r.icon, status: r.status, priority: r.priority, dueDate: r.due_date,
    tagIds: p(r.tag_ids), createdAt: r.created_at, updatedAt: r.updated_at, archivedAt: r.archived_at
  };
}

export function toNote(r: any) {
  return {
    id: r.id, projectId: r.project_id, workspaceId: r.workspace_id, title: r.title,
    content: r.content ?? "", contentText: r.content_text ?? "",
    tagIds: p(r.tag_ids), linkedNoteIds: p(r.linked_note_ids), linkedCardIds: p(r.linked_card_ids),
    isPinned: b(r.is_pinned), folder: (r.folder ?? "") as string,
    createdAt: r.created_at, updatedAt: r.updated_at, archivedAt: r.archived_at
  };
}

export function toColumn(r: any) {
  return {
    id: r.id, projectId: r.project_id, workspaceId: r.workspace_id, name: r.name,
    type: r.type, order: r.order, cardLimit: r.card_limit,
    createdAt: r.created_at, updatedAt: r.updated_at
  };
}

export function toCard(r: any) {
  return {
    id: r.id, columnId: r.column_id, projectId: r.project_id, workspaceId: r.workspace_id,
    title: r.title, description: r.description, tagIds: p(r.tag_ids), priority: r.priority,
    dueDate: r.due_date, linkedNoteIds: p(r.linked_note_ids), blockedByIds: j2(r.blocked_by_ids),
    order: r.order, assignee: r.assignee, createdAt: r.created_at, updatedAt: r.updated_at, archivedAt: r.archived_at
  };
}

// ── Snapshot ──────────────────────────────────

export interface Snapshot {
  workspaces: ReturnType<typeof toWorkspace>[];
  projects: ReturnType<typeof toProject>[];
  notes: ReturnType<typeof toNote>[];
  columns: ReturnType<typeof toColumn>[];
  cards: ReturnType<typeof toCard>[];
  tags: { id: string; workspaceId: string; name: string; color: string }[];
}

export function getSnapshot(db: Database.Database): Snapshot {
  return {
    workspaces: db.prepare("SELECT * FROM workspaces ORDER BY created_at").all().map(toWorkspace),
    projects: db.prepare("SELECT * FROM projects ORDER BY created_at").all().map(toProject),
    notes: db.prepare("SELECT * FROM notes ORDER BY updated_at DESC").all().map(toNote),
    columns: db.prepare(`SELECT * FROM board_columns ORDER BY "order"`).all().map(toColumn),
    cards: db.prepare(`SELECT * FROM task_cards ORDER BY "order"`).all().map(toCard),
    tags: (db.prepare("SELECT * FROM tags ORDER BY name").all() as any[]).map((r) => ({
      id: r.id as string, workspaceId: r.workspace_id as string,
      name: r.name as string, color: r.color as string,
    })),
  };
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

// ── Note File Synchronizer ────────────────────

export function projectNotesDir(workspacePath: string, projectName: string): string {
  return path.join(workspacePath, toSlug(projectName));
}

export function findNoteFilePath(workspacePath: string, projectName: string, noteId: string): string | null {
  const dir = projectNotesDir(workspacePath, projectName);
  if (!fs.existsSync(dir)) return null;
  for (const entry of fs.readdirSync(dir)) {
    if (!entry.endsWith(".md")) continue;
    const fp = path.join(dir, entry);
    try {
      const { data } = matter(fs.readFileSync(fp, "utf-8"));
      if (data.id === noteId) return fp;
    } catch { /* skip */ }
  }
  return null;
}

export function resolveNoteFilePath(workspacePath: string, projectName: string, title: string, noteId: string): string {
  const dir = projectNotesDir(workspacePath, projectName);
  const slug = toSlug(title);
  const candidate = path.join(dir, `${slug}.md`);
  if (!fs.existsSync(candidate)) return candidate;
  try {
    const { data } = matter(fs.readFileSync(candidate, "utf-8"));
    if (data.id === noteId) return candidate;
  } catch { /* collision */ }
  return path.join(dir, `${slug}-${noteId.slice(0, 6)}.md`);
}

export interface NoteFileData {
  id: string; projectId: string; workspaceId: string; title: string; content: string;
  tagIds: string[]; linkedNoteIds: string[]; linkedCardIds: string[];
  isPinned: boolean; folder?: string; createdAt: string; updatedAt: string; archivedAt?: string;
  projectName: string;
}

export function writeNoteFile(workspacePath: string, note: NoteFileData): void {
  const dir = projectNotesDir(workspacePath, note.projectName);
  fs.mkdirSync(dir, { recursive: true });
  const existingPath = findNoteFilePath(workspacePath, note.projectName, note.id);
  const newPath = resolveNoteFilePath(workspacePath, note.projectName, note.title, note.id);
  if (existingPath && existingPath !== newPath) {
    try { fs.unlinkSync(existingPath); } catch { /* ignore */ }
  }

  // Preserve non-Cairn frontmatter (Obsidian tags, aliases, cssclass, etc.)
  const CAIRN_KEYS = new Set([
    "id", "projectId", "workspaceId", "title", "folder",
    "tagIds", "linkedNoteIds", "linkedCardIds",
    "isPinned", "createdAt", "updatedAt", "archivedAt",
  ]);
  const existingExtra: Record<string, unknown> = {};
  try {
    const readPath = existingPath ?? newPath;
    if (fs.existsSync(readPath)) {
      const { data } = matter(fs.readFileSync(readPath, "utf-8"));
      for (const [key, value] of Object.entries(data)) {
        if (!CAIRN_KEYS.has(key)) existingExtra[key] = value;
      }
    }
  } catch { /* ignore */ }

  const cairnFields: Record<string, unknown> = {
    id: note.id, projectId: note.projectId, workspaceId: note.workspaceId,
    title: note.title, tagIds: note.tagIds, linkedNoteIds: note.linkedNoteIds,
    linkedCardIds: note.linkedCardIds, isPinned: note.isPinned,
    createdAt: note.createdAt, updatedAt: note.updatedAt,
  };
  if (note.archivedAt) cairnFields.archivedAt = note.archivedAt;

  // Merge: non-Cairn keys first, then Cairn keys on top (Cairn always wins)
  const frontmatter = { ...existingExtra, ...cairnFields };
  fs.writeFileSync(newPath, matter.stringify(note.content ?? "", frontmatter), "utf-8");
}

export function deleteNoteFile(workspacePath: string, projectName: string, noteId: string): void {
  const fp = findNoteFilePath(workspacePath, projectName, noteId);
  if (fp) { try { fs.unlinkSync(fp); } catch { /* ignore */ } }
}
