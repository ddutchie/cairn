/**
 * Cairn — MCP server (standalone Node.js script)
 *
 * Runs as a plain Node HTTP server on port 3123.
 * No Electron dependency — uses better-sqlite3 built for system Node.
 * Reads/writes the same SQLite DB that the Electron app uses.
 *
 * Started by: npm run mcp
 * External agents connect to: http://localhost:3123
 */

import http from "http";
import path from "path";
import os from "os";
import fs from "fs";
import Database from "better-sqlite3";
import matter from "gray-matter";

// Resolve the better-sqlite3 native binding.
//
// Three environments:
//   1. pkg binary  — __dirname is a virtual snapshot path; the .node file is
//                    a pkg asset extracted to a temp dir next to the binary.
//                    We look for it relative to the real executable path.
//   2. Packaged app (asar.unpacked) — pkg-native/ is unpacked alongside dist-mcp/
//   3. Dev — pkg-native/ at the project root
function resolveMcpNativeBinding(): string | undefined {
  const execDir = path.dirname(process.execPath);
  const candidates = [
    // pkg binary: .node asset extracted next to the executable
    path.join(execDir, "better_sqlite3.node"),
    // Packaged app: pkg-native/ unpacked alongside dist-mcp/
    path.join(__dirname, "..", "pkg-native", "better_sqlite3.node"),
    // Dev: project root pkg-native/
    path.join(__dirname, "..", "..", "pkg-native", "better_sqlite3.node"),
  ];
  return candidates.find((p) => fs.existsSync(p));
}
const MCP_NATIVE_BINDING = resolveMcpNativeBinding();
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

export const MCP_PORT = 3123;

// ── DB path resolution ────────────────────────

/**
 * Try to read the workspace config file written by the Electron app.
 * Returns the path to cairn.db inside the user-chosen workspace folder,
 * or null if the config doesn't exist yet.
 */
function findDbPathFromWorkspaceConfig(): string | null {
  const home = os.homedir();
  const platform = process.platform;

  let base: string;
  if (platform === "win32") {
    base = process.env.APPDATA ?? path.join(home, "AppData", "Roaming");
  } else if (platform === "darwin") {
    base = path.join(home, "Library", "Application Support");
  } else {
    base = process.env.XDG_CONFIG_HOME ?? path.join(home, ".config");
  }

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

function findDbPath(): string | null {
  // First: check the workspace config (user-chosen folder)
  const fromConfig = findDbPathFromWorkspaceConfig();
  if (fromConfig) return fromConfig;

  const home = os.homedir();
  const platform = process.platform;

  let base: string;
  if (platform === "win32") {
    base = process.env.APPDATA ?? path.join(home, "AppData", "Roaming");
  } else if (platform === "darwin") {
    base = path.join(home, "Library", "Application Support");
  } else {
    base = process.env.XDG_CONFIG_HOME ?? path.join(home, ".config");
  }

  // Fallback: search legacy app-data locations, prefer the one with most data
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

// ── Query helpers (inlined to avoid ABI mismatch with Electron build) ──

function j(v: unknown): string { return JSON.stringify(v ?? []); }
function p(v: string | null | undefined): unknown[] {
  if (!v) return [];
  try { return JSON.parse(v); } catch { return []; }
}
function b(v: number | null): boolean { return v === 1; }
function ts(): string { return new Date().toISOString(); }
function newId(): string { return Math.random().toString(36).slice(2, 14); }

/** Strip markdown syntax to plain text for the content_text search column */
function stripMarkdown(md: string): string {
  return md
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/`{1,3}[^`]*`{1,3}/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^[-*+]\s+/gm, "")
    .replace(/^\d+\.\s+/gm, "")
    .replace(/^>\s+/gm, "")
    .replace(/^---+$/gm, "")
    .replace(/\|/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

// ── Note file helpers ─────────────────────────
// The workspace folder path is resolved once at startup (see findWorkspacePath).

function toSlug(str: string): string {
  return str.trim().replace(/[/\\:*?"<>|]/g, "").replace(/\s+/g, " ").slice(0, 100).trim() || "Untitled";
}

function projectNotesDir(workspacePath: string, projectName: string): string {
  return path.join(workspacePath, "notes", toSlug(projectName));
}

function findNoteFilePath(workspacePath: string, projectName: string, noteId: string): string | null {
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

function resolveNoteFilePath(workspacePath: string, projectName: string, title: string, noteId: string): string {
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

interface NoteFileData {
  id: string; projectId: string; workspaceId: string; title: string; content: string;
  tagIds: string[]; linkedNoteIds: string[]; linkedCardIds: string[];
  isPinned: boolean; createdAt: string; updatedAt: string; archivedAt?: string;
  projectName: string;
}

function writeNoteFile(workspacePath: string, note: NoteFileData): void {
  const dir = projectNotesDir(workspacePath, note.projectName);
  fs.mkdirSync(dir, { recursive: true });
  const existingPath = findNoteFilePath(workspacePath, note.projectName, note.id);
  const newPath = resolveNoteFilePath(workspacePath, note.projectName, note.title, note.id);
  if (existingPath && existingPath !== newPath) {
    try { fs.unlinkSync(existingPath); } catch { /* ignore */ }
  }
  const frontmatter: Record<string, unknown> = {
    id: note.id, projectId: note.projectId, workspaceId: note.workspaceId,
    title: note.title, tagIds: note.tagIds, linkedNoteIds: note.linkedNoteIds,
    linkedCardIds: note.linkedCardIds, isPinned: note.isPinned,
    createdAt: note.createdAt, updatedAt: note.updatedAt,
  };
  if (note.archivedAt) frontmatter.archivedAt = note.archivedAt;
  fs.writeFileSync(newPath, matter.stringify(note.content ?? "", frontmatter), "utf-8");
}

function deleteNoteFile(workspacePath: string, projectName: string, noteId: string): void {
  const fp = findNoteFilePath(workspacePath, projectName, noteId);
  if (fp) { try { fs.unlinkSync(fp); } catch { /* ignore */ } }
}

/** Resolve the workspace folder from the config file, falling back to the DB's parent dir. */
function findWorkspacePath(dbPath: string): string {
  const home = os.homedir();
  const platform = process.platform;
  let base: string;
  if (platform === "win32") {
    base = process.env.APPDATA ?? path.join(home, "AppData", "Roaming");
  } else if (platform === "darwin") {
    base = path.join(home, "Library", "Application Support");
  } else {
    base = process.env.XDG_CONFIG_HOME ?? path.join(home, ".config");
  }
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
  // Fallback: the DB's parent directory is the workspace folder
  return path.dirname(dbPath);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toWorkspace(r: any) {
  return { id: r.id, name: r.name, description: r.description, icon: r.icon,
    createdAt: r.created_at, updatedAt: r.updated_at, archivedAt: r.archived_at };
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toProject(r: any) {
  return { id: r.id, workspaceId: r.workspace_id, name: r.name, description: r.description,
    icon: r.icon, status: r.status, priority: r.priority, dueDate: r.due_date,
    tagIds: p(r.tag_ids), createdAt: r.created_at, updatedAt: r.updated_at, archivedAt: r.archived_at };
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toNote(r: any) {
  return { id: r.id, projectId: r.project_id, workspaceId: r.workspace_id, title: r.title,
    content: r.content ?? "", contentText: r.content_text ?? "",
    tagIds: p(r.tag_ids), linkedNoteIds: p(r.linked_note_ids), linkedCardIds: p(r.linked_card_ids),
    isPinned: b(r.is_pinned), createdAt: r.created_at, updatedAt: r.updated_at, archivedAt: r.archived_at };
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toColumn(r: any) {
  return { id: r.id, projectId: r.project_id, workspaceId: r.workspace_id, name: r.name,
    type: r.type, order: r.order, cardLimit: r.card_limit,
    createdAt: r.created_at, updatedAt: r.updated_at };
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toCard(r: any) {
  return { id: r.id, columnId: r.column_id, projectId: r.project_id, workspaceId: r.workspace_id,
    title: r.title, description: r.description, tagIds: p(r.tag_ids), priority: r.priority,
    dueDate: r.due_date, linkedNoteIds: p(r.linked_note_ids), order: r.order,
    assignee: r.assignee, createdAt: r.created_at, updatedAt: r.updated_at, archivedAt: r.archived_at };
}

function getSnapshot(db: Database.Database) {
  return {
    workspaces: db.prepare("SELECT * FROM workspaces ORDER BY created_at").all().map(toWorkspace),
    projects:   db.prepare("SELECT * FROM projects ORDER BY created_at").all().map(toProject),
    notes:      db.prepare("SELECT * FROM notes ORDER BY updated_at DESC").all().map(toNote),
    columns:    db.prepare(`SELECT * FROM board_columns ORDER BY "order"`).all().map(toColumn),
    cards:      db.prepare(`SELECT * FROM task_cards ORDER BY "order"`).all().map(toCard),
  };
}

// ── MCP notification helper ───────────────────

function insertNotification(db: Database.Database, tool: string, title: string, body: string): void {
  try {
    const id = newId();
    db.prepare(
      "INSERT INTO mcp_notifications (id, tool, title, body, read, created_at) VALUES (?, ?, ?, ?, 0, ?)"
    ).run(id, tool, title, body, ts());
  } catch {
    // Table may not exist in very old DBs — best-effort only
  }
}

// ── Tool executor ─────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function executeTool(db: Database.Database, workspacePath: string, toolName: string, args: Record<string, any>): unknown {
  const snap = getSnapshot(db);

  switch (toolName) {
    case "get_cairn_context": {
      const workspaces = snap.workspaces.map((w) => ({ id: w.id, name: w.name }));
      const projects = snap.projects
        .filter((p) => !p.archivedAt)
        .map((p) => ({
          id: p.id, name: p.name, status: p.status, priority: p.priority,
          workspaceId: p.workspaceId,
          columns: snap.columns
            .filter((c) => c.projectId === p.id)
            .sort((a, b) => a.order - b.order)
            .map((c) => ({ id: c.id, name: c.name, type: c.type })),
        }));
      return {
        workspaces,
        projects,
        tools: {
          read:   ["get_cairn_context", "search_notes", "search_tasks", "get_note", "get_task", "get_project_summary", "list_recent_activity"],
          write:  ["create_project", "create_note", "update_note", "create_task", "update_task", "update_task_status", "link_note_to_task"],
          delete: ["delete_note", "delete_task"],
        },
        conventions: {
          notes: "Raw markdown in 'content'. 'content_text' is auto-derived — do not set manually.",
          tasks: "Always provide columnId (not just projectId) when creating a task.",
          priority: ["low", "medium", "high", "urgent"],
          projectStatus: ["active", "on_hold", "completed", "archived"],
          columnTypes: ["backlog", "todo", "in_progress", "review", "done", "custom"],
          createProject: "create_project auto-creates 5 default columns — no need to create them separately.",
        },
      };
    }

    case "search_notes": {
      const { query, projectId, limit = 10 } = args;
      const qr = String(query).toLowerCase();
      return snap.notes
        .filter((n) => {
          if (n.archivedAt) return false;
          if (projectId && n.projectId !== projectId) return false;
          return n.title.toLowerCase().includes(qr) || n.contentText.toLowerCase().includes(qr);
        })
        .slice(0, limit)
        .map((n) => ({ id: n.id, title: n.title, snippet: n.contentText.slice(0, 200), projectId: n.projectId, updatedAt: n.updatedAt }));
    }

    case "search_tasks": {
      const { query, projectId, columnType, limit = 10 } = args;
      const qr = String(query).toLowerCase();
      return snap.cards
        .filter((c) => {
          if (c.archivedAt) return false;
          if (projectId && c.projectId !== projectId) return false;
          if (columnType) {
            const col = snap.columns.find((col) => col.id === c.columnId);
            if (col?.type !== columnType) return false;
          }
          return c.title.toLowerCase().includes(qr) || (c.description ?? "").toLowerCase().includes(qr);
        })
        .slice(0, limit)
        .map((c) => {
          const col = snap.columns.find((col) => col.id === c.columnId);
          return { id: c.id, title: c.title, description: c.description, columnId: c.columnId,
            columnName: col?.name ?? "Unknown", columnType: col?.type ?? "custom",
            priority: c.priority, dueDate: c.dueDate, projectId: c.projectId };
        });
    }

    case "get_project_summary": {
      const project = snap.projects.find((p) => p.id === args.projectId);
      if (!project) return { error: "Project not found" };
      const columns = snap.columns.filter((c) => c.projectId === args.projectId).sort((a, b) => a.order - b.order);
      const cardsByColumn = columns.map((col) => {
        const cards = snap.cards.filter((c) => c.columnId === col.id && !c.archivedAt);
        return { columnName: col.name, columnType: col.type, count: cards.length,
          cards: cards.map((c) => ({ id: c.id, title: c.title, priority: c.priority, dueDate: c.dueDate })) };
      });
      const notes = snap.notes.filter((n) => n.projectId === args.projectId && !n.archivedAt);
      return {
        project: { id: project.id, name: project.name, description: project.description,
          status: project.status, priority: project.priority, dueDate: project.dueDate },
        noteCount: notes.length,
        totalCards: cardsByColumn.reduce((s, c) => s + c.count, 0),
        cardsByColumn,
        pinnedNotes: notes.filter((n) => n.isPinned).map((n) => ({ id: n.id, title: n.title })),
        recentActivity: [
          ...notes.map((n) => ({ type: "note" as const, id: n.id, title: n.title, updatedAt: n.updatedAt })),
          ...snap.cards.filter((c) => c.projectId === args.projectId && !c.archivedAt)
            .map((c) => ({ type: "card" as const, id: c.id, title: c.title, updatedAt: c.updatedAt })),
        ].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()).slice(0, 10),
      };
    }

    case "list_recent_activity": {
      const { workspaceId, projectId, limit = 20 } = args;
      return [
        ...snap.notes
          .filter((n) => n.workspaceId === workspaceId && !n.archivedAt && (!projectId || n.projectId === projectId))
          .map((n) => {
            const proj = snap.projects.find((pr) => pr.id === n.projectId);
            return { type: "note" as const, id: n.id, title: n.title, projectId: n.projectId,
              projectName: proj?.name ?? "", action: (n.createdAt === n.updatedAt ? "created" : "updated") as "created" | "updated", at: n.updatedAt };
          }),
        ...snap.cards
          .filter((c) => c.workspaceId === workspaceId && !c.archivedAt && (!projectId || c.projectId === projectId))
          .map((c) => {
            const proj = snap.projects.find((pr) => pr.id === c.projectId);
            return { type: "card" as const, id: c.id, title: c.title, projectId: c.projectId,
              projectName: proj?.name ?? "", action: (c.createdAt === c.updatedAt ? "created" : "updated") as "created" | "updated", at: c.updatedAt };
          }),
      ].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime()).slice(0, limit);
    }

    case "create_note": {
      const { projectId, title, content } = args;
      const project = snap.projects.find((pr) => pr.id === projectId);
      if (!project) return { error: "Project not found" };
      const now = ts();
      const noteId = newId();
      const markdown = content ?? "";
      db.prepare(`
        INSERT INTO notes (id, project_id, workspace_id, title, content, content_text,
          tag_ids, linked_note_ids, linked_card_ids, is_pinned, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, '[]', '[]', '[]', 0, ?, ?)
      `).run(noteId, projectId, project.workspaceId, title, markdown, stripMarkdown(markdown), now, now);
      writeNoteFile(workspacePath, {
        id: noteId, projectId, workspaceId: project.workspaceId, title, content: markdown,
        tagIds: [], linkedNoteIds: [], linkedCardIds: [], isPinned: false,
        createdAt: now, updatedAt: now, projectName: project.name,
      });
      insertNotification(db, "create_note", "Note created", `"${title}" added to ${project.name}`);
      return { id: noteId, title, createdAt: now };
    }

    case "update_note": {
      const { noteId, title, content } = args;
      const note = snap.notes.find((n) => n.id === noteId);
      if (!note) return { error: "Note not found" };
      const now = ts();
      const markdown = content !== undefined ? content : null;
      db.prepare(`UPDATE notes SET title = COALESCE(?, title), content = COALESCE(?, content), content_text = COALESCE(?, content_text), updated_at = ? WHERE id = ?`)
        .run(title ?? null, markdown, markdown !== null ? stripMarkdown(markdown) : null, now, noteId);
      const updateProj = snap.projects.find((pr) => pr.id === note.projectId);
      writeNoteFile(workspacePath, {
        id: noteId, projectId: note.projectId as string, workspaceId: note.workspaceId as string,
        title: title ?? note.title as string,
        content: markdown !== null ? markdown : note.content as string,
        tagIds: note.tagIds as string[], linkedNoteIds: note.linkedNoteIds as string[],
        linkedCardIds: note.linkedCardIds as string[], isPinned: note.isPinned as boolean,
        createdAt: note.createdAt as string, updatedAt: now,
        archivedAt: note.archivedAt as string | undefined,
        projectName: updateProj?.name ?? note.projectId as string,
      });
      insertNotification(db, "update_note", "Note updated", `"${title ?? note.title}" was updated`);
      return { id: noteId, title: title ?? note.title, updatedAt: now };
    }

    case "create_task": {
      const { columnId, projectId, title, description, priority = "medium", dueDate } = args;
      const col = snap.columns.find((c) => c.id === columnId);
      if (!col) return { error: "Column not found" };
      const now = ts();
      const cardId = newId();
      const order = snap.cards.filter((c) => c.columnId === columnId).length;
      db.prepare(`
        INSERT INTO task_cards (id, column_id, project_id, workspace_id, title, description,
          tag_ids, priority, due_date, linked_note_ids, "order", created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, '[]', ?, ?, '[]', ?, ?, ?)
      `).run(cardId, columnId, projectId, col.workspaceId, title, description ?? null, priority, dueDate ?? null, order, now, now);
      const taskProject = snap.projects.find((pr) => pr.id === projectId);
      insertNotification(db, "create_task", "Task created", `"${title}" added to ${taskProject?.name ?? projectId}`);
      return { id: cardId, title, columnId, createdAt: now };
    }

    case "update_task_status": {
      const { cardId, targetColumnId } = args;
      const card = snap.cards.find((c) => c.id === cardId);
      const col = snap.columns.find((c) => c.id === targetColumnId);
      if (!card) return { error: "Card not found" };
      if (!col) return { error: "Column not found" };
      const now = ts();
      db.prepare(`UPDATE task_cards SET column_id = ?, updated_at = ? WHERE id = ?`).run(targetColumnId, now, cardId);
      insertNotification(db, "update_task_status", "Task moved", `"${card.title}" → ${col.name}`);
      return { id: cardId, title: card.title, previousColumn: card.columnId,
        newColumn: targetColumnId, newColumnName: col.name, updatedAt: now };
    }

    case "link_note_to_task": {
      const { noteId, cardId } = args;
      const note = snap.notes.find((n) => n.id === noteId);
      const card = snap.cards.find((c) => c.id === cardId);
      if (!note) return { error: "Note not found" };
      if (!card) return { error: "Card not found" };
      const newCardIds = j(Array.from(new Set([...(note.linkedCardIds as string[]), cardId])));
      const newNoteIds = j(Array.from(new Set([...(card.linkedNoteIds as string[]), noteId])));
      const now = ts();
      db.prepare(`UPDATE notes SET linked_card_ids = ?, updated_at = ? WHERE id = ?`).run(newCardIds, now, noteId);
      db.prepare(`UPDATE task_cards SET linked_note_ids = ?, updated_at = ? WHERE id = ?`).run(newNoteIds, now, cardId);
      insertNotification(db, "link_note_to_task", "Note linked to task", `"${note.title}" linked to "${card.title}"`);
      return { noteId, cardId, linked: true };
    }

    case "get_note": {
      const note = snap.notes.find((n) => n.id === args.noteId);
      if (!note) return { error: "Note not found" };
      return { id: note.id, title: note.title, content: note.content, projectId: note.projectId, updatedAt: note.updatedAt };
    }

    case "create_project": {
      const workspace = snap.workspaces.find((w) => w.id === args.workspaceId);
      if (!workspace) return { error: "Workspace not found" };
      const projectId = newId();
      const now = ts();
      db.prepare(`INSERT INTO projects (id, workspace_id, name, description, icon, status, priority, tag_ids, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, '[]', ?, ?)`)
        .run(projectId, args.workspaceId, args.name, args.description ?? null, args.icon ?? null,
          args.status ?? "active", args.priority ?? "medium", now, now);
      const defaultColumns = [
        { name: "Backlog",     type: "backlog",     order: 0 },
        { name: "Todo",        type: "todo",        order: 1 },
        { name: "In Progress", type: "in_progress", order: 2 },
        { name: "Review",      type: "review",      order: 3 },
        { name: "Done",        type: "done",        order: 4 },
      ];
      const columns = defaultColumns.map((col) => {
        const colId = newId();
        db.prepare(`INSERT INTO board_columns (id, project_id, workspace_id, name, type, "order", created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(colId, projectId, args.workspaceId, col.name, col.type, col.order, now, now);
        return { id: colId, name: col.name, type: col.type };
      });
      insertNotification(db, "create_project", "Project created", `"${args.name}" was created`);
      return { projectId, name: args.name, columns };
    }

    case "get_task": {
      const card = snap.cards.find((c) => c.id === args.cardId);
      if (!card) return { error: "Task not found" };
      const col = snap.columns.find((c) => c.id === card.columnId);
      return {
        id: card.id, title: card.title, description: card.description,
        priority: card.priority, dueDate: card.dueDate,
        columnId: card.columnId, columnName: col?.name ?? "Unknown", columnType: col?.type ?? "custom",
        linkedNoteIds: card.linkedNoteIds, projectId: card.projectId,
        createdAt: card.createdAt, updatedAt: card.updatedAt,
      };
    }

    case "delete_note": {
      const note = snap.notes.find((n) => n.id === args.noteId);
      if (!note) return { error: "Note not found" };
      const delProj = snap.projects.find((pr) => pr.id === note.projectId);
      db.prepare("DELETE FROM notes WHERE id = ?").run(args.noteId);
      deleteNoteFile(workspacePath, delProj?.name ?? note.projectId as string, args.noteId as string);
      insertNotification(db, "delete_note", "Note deleted", `"${note.title}" was deleted`);
      return { deleted: true, id: args.noteId, title: note.title };
    }

    case "delete_task": {
      const card = snap.cards.find((c) => c.id === args.cardId);
      if (!card) return { error: "Task not found" };
      db.prepare("DELETE FROM task_cards WHERE id = ?").run(args.cardId);
      insertNotification(db, "delete_task", "Task deleted", `"${card.title}" was deleted`);
      return { deleted: true, id: args.cardId, title: card.title };
    }

    case "update_task": {
      const { taskId, title, description, priority, dueDate, columnId, tagIds } = args;
      const card = snap.cards.find((c) => c.id === taskId);
      if (!card) return { error: "Task not found" };
      const now = ts();
      db.prepare(`
        UPDATE task_cards SET
          column_id   = COALESCE(?, column_id),
          title       = COALESCE(?, title),
          description = COALESCE(?, description),
          priority    = COALESCE(?, priority),
          due_date    = COALESCE(?, due_date),
          tag_ids     = COALESCE(?, tag_ids),
          updated_at  = ?
        WHERE id = ?
      `).run(
        columnId ?? null, title ?? null, description ?? null,
        priority ?? null, dueDate ?? null,
        tagIds ? j(tagIds) : null,
        now, taskId
      );
      const updated = db.prepare("SELECT * FROM task_cards WHERE id = ?").get(taskId) as Record<string, unknown> | undefined;
      insertNotification(db, "update_task", "Task updated", `"${title ?? card.title}" was updated`);
      return updated ?? { error: "Task not found after update" };
    }

    case "update_project": {
      const { projectId, name, description, status, priority } = args;
      const project = snap.projects.find((p) => p.id === projectId);
      if (!project) return { error: "Project not found" };
      const now = ts();
      db.prepare(`
        UPDATE projects SET
          name        = COALESCE(?, name),
          description = COALESCE(?, description),
          status      = COALESCE(?, status),
          priority    = COALESCE(?, priority),
          updated_at  = ?
        WHERE id = ?
      `).run(name ?? null, description ?? null, status ?? null, priority ?? null, now, projectId);
      const updated = db.prepare("SELECT * FROM projects WHERE id = ?").get(projectId) as Record<string, unknown> | undefined;
      insertNotification(db, "update_project", "Project updated", `"${name ?? project.name}" was updated`);
      return updated ?? { error: "Project not found after update" };
    }

    case "delete_project": {
      const project = snap.projects.find((p) => p.id === args.projectId);
      if (!project) return { error: "Project not found" };
      // Delete notes dir
      const notesDir = path.join(workspacePath, "notes", project.name.trim().replace(/[/\\:*?"<>|]/g, "").slice(0, 100).trim() || "Untitled");
      if (fs.existsSync(notesDir)) {
        try { fs.rmSync(notesDir, { recursive: true, force: true }); } catch { /* ignore */ }
      }
      db.prepare("DELETE FROM task_cards WHERE project_id = ?").run(args.projectId);
      db.prepare("DELETE FROM board_columns WHERE project_id = ?").run(args.projectId);
      db.prepare("DELETE FROM notes WHERE project_id = ?").run(args.projectId);
      db.prepare("DELETE FROM projects WHERE id = ?").run(args.projectId);
      insertNotification(db, "delete_project", "Project deleted", `"${project.name}" was deleted`);
      return { deleted: true, id: args.projectId, name: project.name };
    }

    case "list_notes": {
      return snap.notes
        .filter((n) => !n.archivedAt && (!args.projectId || n.projectId === args.projectId))
        .map((n) => ({ id: n.id, title: n.title, projectId: n.projectId, isPinned: n.isPinned, updatedAt: n.updatedAt }));
    }

    case "list_tasks": {
      const cols = snap.columns.filter((c) => !args.projectId || c.projectId === args.projectId);
      return cols
        .sort((a, b) => a.order - b.order)
        .map((col) => ({
          columnName: col.name,
          columnType: col.type,
          columnId: col.id,
          tasks: snap.cards
            .filter((c) => c.columnId === col.id && !c.archivedAt)
            .map((c) => ({ id: c.id, title: c.title, priority: c.priority, description: c.description })),
        }));
    }

    default:
      return { error: `Unknown tool: ${toolName}` };
  }
}

// ── Zod shape builder ─────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildZodShape(schema: any): Record<string, z.ZodTypeAny> {
  if (!schema?.properties) return {};
  const shape: Record<string, z.ZodTypeAny> = {};
  const required: string[] = schema.required ?? [];
  for (const [key, prop] of Object.entries(schema.properties as Record<string, any>)) {
    let zodType: z.ZodTypeAny;
    if (prop.enum) { const [first, ...rest] = prop.enum as [string, ...string[]]; zodType = z.enum([first, ...rest]); }
    else if (prop.type === "string") zodType = z.string();
    else if (prop.type === "number") zodType = z.number();
    else zodType = z.unknown();
    if (prop.description) zodType = (zodType as z.ZodString).describe(prop.description);
    if (!required.includes(key)) zodType = zodType.optional();
    if (prop.default !== undefined && !required.includes(key)) zodType = (zodType as z.ZodOptional<z.ZodTypeAny>).default(prop.default);
    shape[key] = zodType;
  }
  return shape;
}

const TOOL_DEFINITIONS = [
  { name: "get_cairn_context",   description: "Returns a full orientation guide for this Cairn instance: workspaces, projects, board columns with IDs, available tools, and data conventions. Call this first if unfamiliar with the workspace.",
    inputSchema: { type: "object", properties: {}, required: [] } },
  { name: "search_notes",        description: "Search notes by query string. Returns title, snippet, projectId.",
    inputSchema: { type: "object", properties: { query: { type: "string", description: "Search query" }, projectId: { type: "string", description: "Filter by project ID" }, limit: { type: "number", default: 10 } }, required: ["query"] } },
  { name: "search_tasks",        description: "Search task cards by query string.",
    inputSchema: { type: "object", properties: { query: { type: "string" }, projectId: { type: "string" }, columnType: { type: "string", enum: ["backlog","todo","in_progress","review","done"] }, limit: { type: "number", default: 10 } }, required: ["query"] } },
  { name: "get_project_summary", description: "Get a full summary of a project: card counts by column, notes, recent activity.",
    inputSchema: { type: "object", properties: { projectId: { type: "string", description: "Project ID" } }, required: ["projectId"] } },
  { name: "list_recent_activity",description: "List recently created/updated notes and tasks in a workspace.",
    inputSchema: { type: "object", properties: { workspaceId: { type: "string" }, projectId: { type: "string" }, limit: { type: "number", default: 20 } }, required: ["workspaceId"] } },
  { name: "create_note",         description: "Create a new note in a project.",
    inputSchema: { type: "object", properties: { projectId: { type: "string" }, title: { type: "string" }, content: { type: "string" } }, required: ["projectId", "title"] } },
  { name: "update_note",         description: "Update a note's title or content (markdown string).",
    inputSchema: { type: "object", properties: { noteId: { type: "string" }, title: { type: "string" }, content: { type: "string" } }, required: ["noteId"] } },
  { name: "create_task",         description: "Create a task card in a board column.",
    inputSchema: { type: "object", properties: { columnId: { type: "string" }, projectId: { type: "string" }, title: { type: "string" }, description: { type: "string" }, priority: { type: "string", enum: ["low","medium","high","urgent"] }, dueDate: { type: "string" } }, required: ["columnId", "projectId", "title"] } },
  { name: "update_task_status",  description: "Move a task card to a different column.",
    inputSchema: { type: "object", properties: { cardId: { type: "string" }, targetColumnId: { type: "string" } }, required: ["cardId", "targetColumnId"] } },
  { name: "link_note_to_task",   description: "Bidirectionally link a note and a task card.",
    inputSchema: { type: "object", properties: { noteId: { type: "string" }, cardId: { type: "string" } }, required: ["noteId", "cardId"] } },
  { name: "get_note",            description: "Get the full content of a note by its ID.",
    inputSchema: { type: "object", properties: { noteId: { type: "string" } }, required: ["noteId"] } },
  { name: "get_task",            description: "Get full detail of a task card by its ID — title, description, priority, dueDate, column, linked notes.",
    inputSchema: { type: "object", properties: { cardId: { type: "string" } }, required: ["cardId"] } },
  { name: "create_project",      description: "Create a new project in a workspace with default board columns (Backlog, Todo, In Progress, Review, Done).",
    inputSchema: { type: "object", properties: { workspaceId: { type: "string" }, name: { type: "string" }, description: { type: "string" }, icon: { type: "string", description: "A single emoji" }, status: { type: "string", enum: ["active","on_hold","completed","archived"] }, priority: { type: "string", enum: ["low","medium","high","urgent"] } }, required: ["workspaceId", "name"] } },
  { name: "delete_note",         description: "Permanently delete a note by its ID.",
    inputSchema: { type: "object", properties: { noteId: { type: "string" } }, required: ["noteId"] } },
  { name: "delete_task",         description: "Permanently delete a task card by its ID.",
    inputSchema: { type: "object", properties: { cardId: { type: "string" } }, required: ["cardId"] } },
  { name: "update_task",         description: "Update a task card's fields (title, description, priority, dueDate, columnId, tagIds).",
    inputSchema: { type: "object", properties: { taskId: { type: "string" }, title: { type: "string" }, description: { type: "string" }, priority: { type: "string", enum: ["low","medium","high","urgent"] }, dueDate: { type: "string" }, columnId: { type: "string" }, tagIds: { type: "string" } }, required: ["taskId"] } },
  { name: "update_project",      description: "Update a project's name, description, status, or priority.",
    inputSchema: { type: "object", properties: { projectId: { type: "string" }, name: { type: "string" }, description: { type: "string" }, status: { type: "string", enum: ["active","on_hold","completed","archived"] }, priority: { type: "string", enum: ["low","medium","high","urgent"] } }, required: ["projectId"] } },
  { name: "delete_project",      description: "Permanently delete a project and all its notes, tasks, and columns.",
    inputSchema: { type: "object", properties: { projectId: { type: "string" } }, required: ["projectId"] } },
  { name: "list_notes",          description: "List all notes in a project.",
    inputSchema: { type: "object", properties: { projectId: { type: "string" } }, required: [] } },
  { name: "list_tasks",          description: "List all tasks in a project, grouped by column.",
    inputSchema: { type: "object", properties: { projectId: { type: "string" } }, required: [] } },
] as const;

// ── MCP server factory ────────────────────────

function buildMcpServer(db: Database.Database, workspacePath: string): McpServer {
  const server = new McpServer({ name: "cairn", version: "1.0.0" });

  for (const def of TOOL_DEFINITIONS) {
    server.tool(def.name, def.description, buildZodShape(def.inputSchema),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async (args: Record<string, any>) => {
        const result = executeTool(db, workspacePath, def.name, args);
        const hasError = typeof result === "object" && result !== null && !Array.isArray(result) && "error" in result;
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }],
          ...(hasError ? { isError: true } : {}) };
      }
    );
  }

  server.resource("workspaces", "cairn://workspaces", { mimeType: "application/json" }, async () => ({
    contents: [{ uri: "cairn://workspaces", mimeType: "application/json",
      text: JSON.stringify(db.prepare("SELECT * FROM workspaces").all().map(toWorkspace)) }],
  }));
  server.resource("projects", "cairn://projects", { mimeType: "application/json" }, async () => ({
    contents: [{ uri: "cairn://projects", mimeType: "application/json",
      text: JSON.stringify(db.prepare("SELECT * FROM projects WHERE archived_at IS NULL").all().map(toProject)) }],
  }));

  return server;
}

// ── HTTP server ───────────────────────────────

export function startMcpServer(db: Database.Database, workspacePath: string): http.Server {
  const server = http.createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept");

    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

    if (req.url === "/health") {
      const snap = getSnapshot(db);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, source: "sqlite",
        counts: { workspaces: snap.workspaces.length, projects: snap.projects.length,
          notes: snap.notes.length, cards: snap.cards.length } }));
      return;
    }

    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = Buffer.concat(chunks);

      const webReq = new Request(`http://localhost:${MCP_PORT}${req.url}`, {
        method: req.method,
        headers: Object.fromEntries(
          Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : v ?? ""])
        ),
        body: body.length > 0 ? body : undefined,
      });

      const mcpServer = buildMcpServer(db, workspacePath);
      const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await mcpServer.connect(transport);
      const webRes = await transport.handleRequest(webReq);

      res.writeHead(webRes.status, Object.fromEntries(webRes.headers.entries()));
      res.end(Buffer.from(await webRes.arrayBuffer()));
    } catch (err) {
      console.error("[cairn:mcp]", err);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal MCP server error" }));
    }
  });

  server.listen(MCP_PORT, "127.0.0.1", () => {
    process.stderr.write(`[cairn:mcp] Listening on http://localhost:${MCP_PORT}\n`);
  });

  return server;
}

// ── Standalone entry point ────────────────────
// Invoked by OpenCode via: node dist-mcp/mcp-server.js
// Uses stdio transport so OpenCode can communicate via stdin/stdout.

if (require.main === module) {
  const dbPath = findDbPath();
  if (!dbPath) {
    process.stderr.write("[cairn:mcp] No Cairn database found. Open the Cairn app first.\n");
    process.exit(1);
  }
  process.stderr.write(`[cairn:mcp] Using database: ${dbPath}\n`);
  const db = new Database(dbPath, ...(MCP_NATIVE_BINDING ? [{ nativeBinding: MCP_NATIVE_BINDING }] : []));
  const workspacePath = findWorkspacePath(dbPath);
  process.stderr.write(`[cairn:mcp] Workspace folder: ${workspacePath}\n`);
  const server = buildMcpServer(db, workspacePath);
  const transport = new StdioServerTransport();
  server.connect(transport).catch((err) => {
    process.stderr.write(`[cairn:mcp] Fatal: ${err}\n`);
    process.exit(1);
  });
}
