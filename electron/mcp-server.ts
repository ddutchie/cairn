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
import { toSlug, stripMarkdown } from "./shared/text-utils";

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
import dagre from "@dagrejs/dagre";
import { newId, ts } from "./db/utils";
import { DEFAULT_COLUMNS } from "./db/defaults";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod";
import { TOOL_SCHEMAS, CHAT_ONLY_TOOLS } from "./lib/tool-schemas";

export const MCP_PORT = 3123;

// ── Static reference constants ─────────────────

const DASHBOARD_CONSTANTS = {
  description: "window.cairn API for Cairn dashboards (rendered in a sandboxed iframe).",
  rules: [
    "html must be a complete self-contained document with inline CSS/JS only — no external URLs",
    "Never hardcode projectId or workspaceId — always use window.cairn.projectId and window.cairn.workspaceId",
    "Always fetch data dynamically via helpers — never bake in static data",
  ],
  helpers: {
    "window.cairn.projectId": "Active project ID (string)",
    "window.cairn.workspaceId": "Active workspace ID (string)",
    "window.cairn.getProjectSummary(projectId?)": "Returns { project, noteCount, totalCards, columns: [{ id, name, type, taskCount, tasks: [{ id, title, priority, dueDate }] }] }",
    "window.cairn.listTasks(projectId?)": "Returns { tasksByColumn: { COLUMN_ID: [{ id, title, priority, description, dueDate, columnId, columnName, columnType, updatedAt }] } }. Usage: Object.values(result.tasksByColumn).flat()",
    "window.cairn.listNotes(projectId?)": "Returns [{ id, title, projectId, isPinned, updatedAt }]",
    "window.cairn.listRecentActivity(opts?)": "Returns { recentNotes: [{ id, title, projectId, updatedAt }], recentTasks: [{ id, title, projectId, updatedAt }] }",
    "window.cairn.searchTasks(query, projectId?)": "Returns [{ id, title, priority, columnId }]",
    "window.cairn.searchNotes(query, projectId?)": "Returns [{ id, title, snippet, projectId }]",
    "window.cairn.getContext()": "Returns { workspaces, projects: [{ id, name, status, priority, columns: [{ id, name, type }] }] }",
  },
};

const IDEA_FLOW_RULES = {
  description: "Idea Flow node types, data shapes, and group conventions.",
  nodeTypes: {
    idea:        "Free-form thought. data: { title, body }",
    note_ref:    "Links to an existing note. data: { noteId }",
    task_ref:    "Links to an existing task card. data: { cardId }",
    url:         "External reference. data: { url, title?, description? }",
    ai_summary:  "AI-generated summary. data: { content }. Do not connect edges TO this from other ai_summary nodes.",
    group:       "Spatial container. data: { label?, color? }. Do NOT connect edges to/from group nodes.",
  },
  positioning: [
    "Always call get_idea_flow first — use spatial.nextPosition as the base {x,y} for new nodes, incrementing y by ~120px per row",
    "get_idea_flow returns absoluteX/absoluteY on every node for full canvas reasoning",
  ],
  groups: [
    "Create the group node first, then create child nodes with parentId set to the group's ID",
    "Child coordinates are relative to the group's top-left corner — use spatial.groupSlots[groupId] as starting position, increment y ~100px per row",
    "layout_idea_flow runs two-phase: children arranged inside groups first, then groups + ungrouped nodes arranged together",
    "Always call layout_idea_flow after bulk-creating grouped nodes",
  ],
};

// ── DB path resolution ────────────────────────

/** Returns the OS-specific app-config base directory. */
function getConfigBasePath(): string {
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
 * Try to read the workspace config file written by the Electron app.
 * Returns the path to cairn.db inside the user-chosen workspace folder,
 * or null if the config doesn't exist yet.
 */
function findDbPathFromWorkspaceConfig(): string | null {
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

function findDbPath(): string | null {
  // First: check the workspace config (user-chosen folder)
  const fromConfig = findDbPathFromWorkspaceConfig();
  if (fromConfig) return fromConfig;

  const base = getConfigBasePath();

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
function j2(v: string | null | undefined): string[] {
  if (!v) return [];
  try { return JSON.parse(v) as string[]; } catch { return []; }
}
function p(v: string | null | undefined): unknown[] {
  if (!v) return [];
  try { return JSON.parse(v); } catch { return []; }
}
function b(v: number | null): boolean { return v === 1; }

// ── Note file helpers ─────────────────────────
// NOTE: The note-file helpers (writeNoteFile, deleteNoteFile, etc.) intentionally
// duplicate electron/notes-files.ts because mcp-server.ts is bundled as a
// self-contained binary (pkg) running under system Node (ABI 127), while
// notes-files.ts is compiled for Electron's Node ABI (145). The two ABIs are
// incompatible at runtime for the better-sqlite3 binding.
//
// toSlug and stripMarkdown have NO native dependency and are now shared via
// electron/shared/text-utils.ts (imported above). If you update the note-file
// helper logic, keep these helpers in sync with notes-files.ts manually.
// The workspace folder path is resolved once at startup (see findWorkspacePath).

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
  isPinned: boolean; folder?: string; createdAt: string; updatedAt: string; archivedAt?: string;
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
    isPinned: b(r.is_pinned), folder: (r.folder ?? "") as string,
    createdAt: r.created_at, updatedAt: r.updated_at, archivedAt: r.archived_at };
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
    dueDate: r.due_date, linkedNoteIds: p(r.linked_note_ids), blockedByIds: j2(r.blocked_by_ids),
    order: r.order, assignee: r.assignee, createdAt: r.created_at, updatedAt: r.updated_at, archivedAt: r.archived_at };
}

export function getSnapshot(db: Database.Database) {
  return {
    workspaces: db.prepare("SELECT * FROM workspaces ORDER BY created_at").all().map(toWorkspace),
    projects:   db.prepare("SELECT * FROM projects ORDER BY created_at").all().map(toProject),
    notes:      db.prepare("SELECT * FROM notes ORDER BY updated_at DESC").all().map(toNote),
    columns:    db.prepare(`SELECT * FROM board_columns ORDER BY "order"`).all().map(toColumn),
    cards:      db.prepare(`SELECT * FROM task_cards ORDER BY "order"`).all().map(toCard),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tags:       (db.prepare("SELECT * FROM tags ORDER BY name").all() as any[]).map((r) => ({
      id: r.id as string, workspaceId: r.workspace_id as string,
      name: r.name as string, color: r.color as string,
    })),
  };
}

// ── MCP active-write lock helpers ─────────────
//
// Tracks which note IDs are currently being written by this MCP process so the
// Electron renderer can show a read-only indicator. Uses the mcp_active_writes
// table (created by migration v11; also ensured inline here because applySchema
// is not called in the MCP process due to the Node ABI boundary).
//
// Usage:  lockNote(db, noteId); try { ...write... } finally { unlockNote(db, noteId); }

function ensureMcpActiveWritesTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS mcp_active_writes (
      note_id    TEXT NOT NULL PRIMARY KEY,
      started_at TEXT NOT NULL
    );
  `);
  // Purge stale rows from a previous crashed process (> 30 s old)
  db.prepare("DELETE FROM mcp_active_writes WHERE started_at < datetime('now', '-30 seconds')").run();
}

function lockNote(db: Database.Database, noteId: string): void {
  try {
    db.prepare("INSERT OR REPLACE INTO mcp_active_writes (note_id, started_at) VALUES (?, datetime('now'))").run(noteId);
  } catch { /* best-effort */ }
}

function unlockNote(db: Database.Database, noteId: string): void {
  try {
    db.prepare("DELETE FROM mcp_active_writes WHERE note_id = ?").run(noteId);
  } catch { /* best-effort */ }
}

// ── Optimistic-concurrency helper ─────────────
// Returns null when no version column exists yet (pre-v12 DB).
function getNoteVersion(db: Database.Database, noteId: string): number | null {
  try {
    const row = db.prepare("SELECT version FROM notes WHERE id = ?").get(noteId) as { version: number } | undefined;
    return row?.version ?? null;
  } catch {
    return null;
  }
}

// Returns null when no version column exists yet (pre-v13 DB).
function getCardVersion(db: Database.Database, cardId: string): number | null {
  try {
    const row = db.prepare("SELECT version FROM task_cards WHERE id = ?").get(cardId) as { version: number } | undefined;
    return row?.version ?? null;
  } catch {
    return null;
  }
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
export function executeTool(db: Database.Database, workspacePath: string, toolName: string, args: Record<string, any>): unknown {
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
        tags: snap.tags.map((t) => ({ id: t.id, name: t.name, color: t.color, workspaceId: t.workspaceId })),
        tools: {
          read:   ["get_cairn_context", "get_project_context_pack", "resolve_project", "search_notes", "search_tasks", "get_note", "get_task", "get_project_summary", "list_notes", "list_tasks", "list_ready_tasks", "list_recent_activity"],
          write:  ["create_project", "update_project", "create_note", "import_note_from_file", "ensure_note", "append_to_note", "patch_note", "update_note", "move_note", "create_task", "update_task", "update_task_status", "bulk_update_task_status", "archive_task", "restore_task", "link_note_to_task", "block_task", "unblock_task", "create_dashboard", "update_dashboard", "create_idea_flow_node", "update_idea_flow_node", "create_idea_flow_edge", "create_tag"],
          delete: ["delete_note", "delete_task", "delete_project", "delete_idea_flow_node", "delete_idea_flow_edge"],
          ideaFlow: ["get_idea_flow", "create_idea_flow_node", "update_idea_flow_node", "delete_idea_flow_node", "create_idea_flow_edge", "delete_idea_flow_edge", "layout_idea_flow"],
        },
        conventions: {
          notes: "Raw markdown in 'content'. 'content_text' is auto-derived — do not set manually.",
          dashboards: "Use create_dashboard to create an HTML dashboard rendered in a sandboxed iframe inside Cairn. The 'html' field must be a complete, self-contained HTML document. Use inline CSS and JS only — no external URLs. The window.cairn.query(tool, args) API is available for live data from read-only tools.",
          tasks: "Always provide columnId (not just projectId) when creating a task. Use list_ready_tasks instead of list_tasks when you want to know what work can start now — it filters out tasks blocked by unresolved dependencies.",
          dependencies: "Use block_task to mark a task as blocked by another (same project only). Circular dependencies are rejected. When a blocker is moved to a done column or archived it is automatically treated as resolved. Use unblock_task to remove a dependency explicitly.",
          priority: ["low", "medium", "high", "urgent"],
          projectStatus: ["active", "on_hold", "completed", "archived"],
          columnTypes: ["backlog", "todo", "in_progress", "review", "done", "custom"],
          createProject: "create_project auto-creates 5 default columns — no need to create them separately.",
        },
      };
    }

    case "get_project_context_pack": {
      // Single call that bundles: project metadata + columns + pinned note content
      // + open tasks + recent activity. Replaces 4-5 separate tool calls for agents
      // that need a full picture of a project before taking action.
      const project = snap.projects.find((p) => p.id === args.projectId);
      if (!project) return { error: "Project not found" };
      const columns = snap.columns
        .filter((c) => c.projectId === project.id)
        .sort((a, b) => a.order - b.order);
      const notes = snap.notes.filter((n) => n.projectId === project.id && !n.archivedAt);
      const pinnedNotes = notes
        .filter((n) => n.isPinned)
        .map((n) => ({ id: n.id, title: n.title, content: n.content }));
      const openCards = columns
        .filter((col) => col.type !== "done")
        .map((col) => ({
          columnName: col.name, columnType: col.type, columnId: col.id,
          tasks: snap.cards
            .filter((c) => c.columnId === col.id && !c.archivedAt)
            .map((c) => ({ id: c.id, title: c.title, priority: c.priority, description: c.description ?? null })),
        }))
        .filter((col) => col.tasks.length > 0);
      const recentActivity = [
        ...notes.map((n) => ({ type: "note" as const, id: n.id, title: n.title, updatedAt: n.updatedAt })),
        ...snap.cards
          .filter((c) => c.projectId === project.id && !c.archivedAt)
          .map((c) => ({ type: "card" as const, id: c.id, title: c.title, updatedAt: c.updatedAt })),
      ]
        .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
        .slice(0, 10);
      return {
        project: {
          id: project.id, name: project.name, description: project.description ?? null,
          status: project.status, priority: project.priority,
          columns: columns.map((c) => ({ id: c.id, name: c.name, type: c.type })),
        },
        noteCount: notes.length,
        pinnedNotes,
        openTasks: openCards,
        recentActivity,
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

    case "create_dashboard": {
      const { projectId, title, html } = args;
      const project = snap.projects.find((pr) => pr.id === projectId);
      if (!project) return { error: "Project not found" };
      const now = ts();
      const noteId = newId();
      db.prepare(`
        INSERT INTO notes (id, project_id, workspace_id, title, content, content_text,
          tag_ids, linked_note_ids, linked_card_ids, is_pinned, type, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, '[]', '[]', '[]', 0, 'dashboard', ?, ?)
      `).run(noteId, projectId, project.workspaceId, title, html ?? "", "", now, now);
      insertNotification(db, "create_dashboard", "Dashboard created", `"${title}" added to ${project.name}`);
      return { id: noteId, title, createdAt: now };
    }

    case "update_dashboard": {
      const { noteId, title, html } = args;
      const note = snap.notes.find((n) => n.id === noteId);
      if (!note) return { error: "Dashboard not found" };
      const now = ts();
      db.prepare(`UPDATE notes SET title = COALESCE(?, title), content = COALESCE(?, content), updated_at = ? WHERE id = ?`)
        .run(title ?? null, html ?? null, now, noteId);
      insertNotification(db, "update_dashboard", "Dashboard updated", `"${title ?? note.title}" was updated`);
      return { id: noteId, title: title ?? note.title, updatedAt: now };
    }

    case "get_dashboard_constants":
      return DASHBOARD_CONSTANTS;

    case "get_idea_flow_rules":
      return IDEA_FLOW_RULES;

    case "create_note": {
      const { projectId, title, content, tagIds } = args;
      const project = snap.projects.find((pr) => pr.id === projectId);
      if (!project) return { error: "Project not found" };
      const now = ts();
      const noteId = newId();
      const markdown = content ?? "";
      const resolvedTagIds = Array.isArray(tagIds) ? tagIds as string[] : [];
      const folder = typeof args.folder === "string" ? args.folder : "";
      lockNote(db, noteId);
      try {
        db.transaction(() => {
          db.prepare(`
            INSERT INTO notes (id, project_id, workspace_id, title, content, content_text,
              tag_ids, linked_note_ids, linked_card_ids, is_pinned, type, folder, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, '[]', '[]', 0, 'note', ?, ?, ?)
          `).run(noteId, projectId, project.workspaceId, title, markdown, stripMarkdown(markdown), j(resolvedTagIds), folder, now, now);
          insertNotification(db, "create_note", "Note created", `"${title}" added to ${project.name}${folder ? ` (${folder})` : ""}`);
        })();
        writeNoteFile(workspacePath, {
          id: noteId, projectId, workspaceId: project.workspaceId, title, content: markdown,
          tagIds: resolvedTagIds, linkedNoteIds: [], linkedCardIds: [], isPinned: false,
          folder, createdAt: now, updatedAt: now, projectName: project.name,
        });
        return { id: noteId, title, folder, createdAt: now };
      } finally {
        unlockNote(db, noteId);
      }
    }

    case "import_note_from_file": {
      // Reads a file from the local filesystem (server-side) so agents never need to
      // inline large payloads (e.g. a full README) as tool arguments.
      const { projectId, filePath: srcPath, title: explicitTitle, tagIds: importTagIds } = args;
      const project = snap.projects.find((pr) => pr.id === projectId);
      if (!project) return { error: "Project not found" };
      const resolvedPath = path.resolve(srcPath as string);
      if (!fs.existsSync(resolvedPath)) return { error: `File not found: ${resolvedPath}` };
      let markdown: string;
      try {
        markdown = fs.readFileSync(resolvedPath, "utf8");
      } catch (e) {
        return { error: `Cannot read file: ${(e as Error).message}` };
      }
      // Use explicit title, or strip extension from filename as fallback
      const title = (explicitTitle as string | undefined)
        ?? path.basename(resolvedPath).replace(/\.[^/.]+$/, "");
      const now = ts();
      const noteId = newId();
      const importResolvedTagIds = Array.isArray(importTagIds) ? importTagIds as string[] : [];
      db.transaction(() => {
        db.prepare(`
          INSERT INTO notes (id, project_id, workspace_id, title, content, content_text,
            tag_ids, linked_note_ids, linked_card_ids, is_pinned, type, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, '[]', '[]', 0, 'note', ?, ?)
        `).run(noteId, projectId, project.workspaceId, title, markdown, stripMarkdown(markdown), j(importResolvedTagIds), now, now);
        insertNotification(db, "create_note", "Note imported", `"${title}" imported into ${project.name}`);
      })();
      writeNoteFile(workspacePath, {
        id: noteId, projectId, workspaceId: project.workspaceId, title, content: markdown,
        tagIds: importResolvedTagIds, linkedNoteIds: [], linkedCardIds: [], isPinned: false,
        createdAt: now, updatedAt: now, projectName: project.name,
      });
      return { id: noteId, title, createdAt: now, importedFrom: resolvedPath };
    }

    case "update_note": {
      const { noteId, title, content, isPinned, tagIds, expectedVersion } = args;
      const note = snap.notes.find((n) => n.id === noteId);
      if (!note) return { error: "Note not found" };
      // Optimistic-concurrency check — reject if the caller's snapshot is stale.
      if (expectedVersion !== undefined) {
        const currentVersion = getNoteVersion(db, noteId as string);
        if (currentVersion !== null && currentVersion !== (expectedVersion as number)) {
          return { error: `Version conflict: note has been modified (expected v${expectedVersion as number}, got v${currentVersion}). Fetch the latest content before retrying.` };
        }
      }
      const now = ts();
      const markdown = content !== undefined ? content : null;
      const pinnedVal = isPinned !== undefined ? (isPinned ? 1 : 0) : null;
      const tagIdsJson = Array.isArray(tagIds) ? j(tagIds) : null;
      lockNote(db, noteId as string);
      try {
        const resolvedIsPinned = isPinned !== undefined ? (isPinned as boolean) : note.isPinned as boolean;
        const updateProj = snap.projects.find((pr) => pr.id === note.projectId);
        // Wrap both SQL writes in a transaction so a partial failure leaves the
        // DB consistent (both committed or neither).
        db.transaction(() => {
          db.prepare(`UPDATE notes SET title = COALESCE(?, title), content = COALESCE(?, content), content_text = COALESCE(?, content_text), is_pinned = COALESCE(?, is_pinned), tag_ids = COALESCE(?, tag_ids), updated_at = ?, version = version + 1 WHERE id = ?`)
            .run(title ?? null, markdown, markdown !== null ? stripMarkdown(markdown) : null, pinnedVal, tagIdsJson, now, noteId);
          insertNotification(db, "update_note", "Note updated", `"${title ?? note.title}" was updated`);
        })();
        writeNoteFile(workspacePath, {
          id: noteId, projectId: note.projectId as string, workspaceId: note.workspaceId as string,
          title: title ?? note.title as string,
          content: markdown !== null ? markdown : note.content as string,
          tagIds: Array.isArray(tagIds) ? tagIds as string[] : note.tagIds as string[], linkedNoteIds: note.linkedNoteIds as string[],
          linkedCardIds: note.linkedCardIds as string[], isPinned: resolvedIsPinned,
          createdAt: note.createdAt as string, updatedAt: now,
          archivedAt: note.archivedAt as string | undefined,
          projectName: updateProj?.name ?? note.projectId as string,
        });
        return { id: noteId, title: title ?? note.title, isPinned: resolvedIsPinned, updatedAt: now };
      } finally {
        unlockNote(db, noteId as string);
      }
    }

    case "move_note": {
      const { noteId, targetProjectId } = args;
      const note = snap.notes.find((n) => n.id === noteId);
      if (!note) return { error: "Note not found" };
      const targetProject = snap.projects.find((p) => p.id === targetProjectId);
      if (!targetProject) return { error: "Target project not found" };
      if (note.projectId === targetProjectId) return { error: "Note is already in that project" };
      const sourceProject = snap.projects.find((p) => p.id === note.projectId);
      const now = ts();
      // Remove .md from source folder
      deleteNoteFile(workspacePath, sourceProject?.name ?? note.projectId as string, noteId as string);
      // Update DB
      db.prepare(`UPDATE notes SET project_id = ?, workspace_id = ?, updated_at = ? WHERE id = ?`)
        .run(targetProject.id, targetProject.workspaceId, now, noteId);
      // Write .md to target folder
      writeNoteFile(workspacePath, {
        id: noteId as string, projectId: targetProject.id, workspaceId: targetProject.workspaceId,
        title: note.title as string, content: note.content as string,
        tagIds: note.tagIds as string[], linkedNoteIds: note.linkedNoteIds as string[],
        linkedCardIds: note.linkedCardIds as string[], isPinned: note.isPinned as boolean,
        createdAt: note.createdAt as string, updatedAt: now,
        archivedAt: note.archivedAt as string | undefined,
        projectName: targetProject.name,
      });
      insertNotification(db, "move_note", "Note moved", `"${note.title}" → ${targetProject.name}`);
      return { id: noteId, title: note.title, previousProjectId: note.projectId, newProjectId: targetProject.id };
    }

    case "create_task": {
      const { columnId, projectId, description, priority = "medium", dueDate, tagIds } = args;
      const title = (args.title as string | null | undefined)?.trim();
      if (!title) return { error: "Task title is required" };
      const col = snap.columns.find((c) => c.id === columnId);
      if (!col) return { error: "Column not found" };
      const now = ts();
      const cardId = newId();
      const order = snap.cards.filter((c) => c.columnId === columnId).length;
      const resolvedTagIds = Array.isArray(tagIds) ? tagIds as string[] : [];
      db.prepare(`
        INSERT INTO task_cards (id, column_id, project_id, workspace_id, title, description,
          tag_ids, priority, due_date, linked_note_ids, "order", created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, ?)
      `).run(cardId, columnId, projectId, col.workspaceId, title, description ?? null, j(resolvedTagIds), priority, dueDate ?? null, order, now, now);
      const taskProject = snap.projects.find((pr) => pr.id === projectId);
      insertNotification(db, "create_task", "Task created", `"${title}" added to ${taskProject?.name ?? projectId}`);
      return { id: cardId, title, columnId, createdAt: now };
    }

    case "update_task_status": {
      const { cardId, targetColumnId, expectedVersion: statusExpectedVersion } = args;
      const card = snap.cards.find((c) => c.id === cardId);
      const col = snap.columns.find((c) => c.id === targetColumnId);
      if (!card) return { error: "Card not found" };
      if (!col) return { error: "Column not found" };
      if (statusExpectedVersion !== undefined) {
        const currentVersion = getCardVersion(db, cardId as string);
        if (currentVersion !== null && currentVersion !== (statusExpectedVersion as number)) {
          return { error: `Version conflict: task has been modified (expected v${statusExpectedVersion as number}, got v${currentVersion}). Fetch the latest state before retrying.` };
        }
      }
      const now = ts();
      db.prepare(`UPDATE task_cards SET column_id = ?, updated_at = ?, version = version + 1 WHERE id = ?`).run(targetColumnId, now, cardId);
      // When a task moves to a done column, clear it from any other task's blocked_by_ids
      // so get_task no longer reports it as a pending blocker.
      if (col.type === "done") {
        const affected = db.prepare(
          "SELECT id, blocked_by_ids FROM task_cards WHERE blocked_by_ids != '[]' AND id != ?"
        ).all(cardId) as { id: string; blocked_by_ids: string }[];
        for (const row of affected) {
          const ids: string[] = j2(row.blocked_by_ids);
          if (ids.includes(cardId as string)) {
            db.prepare("UPDATE task_cards SET blocked_by_ids = ?, updated_at = ?, version = version + 1 WHERE id = ?")
              .run(j(ids.filter((bid) => bid !== cardId)), now, row.id);
          }
        }
      }
      insertNotification(db, "update_task_status", "Task moved", `"${card.title}" → ${col.name}`);
      return { id: cardId, title: card.title, previousColumn: card.columnId,
        newColumn: targetColumnId, newColumnName: col.name, updatedAt: now };
    }

    case "bulk_update_task_status": {
      const { cardIds, targetColumnId } = args as { cardIds: string[]; targetColumnId: string };
      const col = snap.columns.find((c) => c.id === targetColumnId);
      if (!col) return { error: "Column not found" };
      if (!Array.isArray(cardIds) || cardIds.length === 0) return { error: "cardIds must be a non-empty array" };
      const results: Array<{ id: string; ok: boolean; error?: string }> = [];
      const now = ts();
      for (const id of cardIds) {
        const card = snap.cards.find((c) => c.id === id);
        if (!card) {
          results.push({ id, ok: false, error: "Task not found" });
        } else {
          db.prepare(`UPDATE task_cards SET column_id = ?, updated_at = ?, version = version + 1 WHERE id = ?`).run(targetColumnId, now, id);
          results.push({ id, ok: true });
        }
      }
      // When moving to a done column, clear all successfully-moved IDs from
      // any other task's blocked_by_ids.
      if (col.type === "done") {
        const movedIds = results.filter((r) => r.ok).map((r) => r.id);
        if (movedIds.length > 0) {
          const affected = db.prepare(
            "SELECT id, blocked_by_ids FROM task_cards WHERE blocked_by_ids != '[]'"
          ).all() as { id: string; blocked_by_ids: string }[];
          for (const row of affected) {
            if (movedIds.includes(row.id)) continue; // skip the tasks we just moved
            const ids: string[] = j2(row.blocked_by_ids);
            const cleaned = ids.filter((bid) => !movedIds.includes(bid));
            if (cleaned.length !== ids.length) {
              db.prepare("UPDATE task_cards SET blocked_by_ids = ?, updated_at = ?, version = version + 1 WHERE id = ?")
                .run(j(cleaned), now, row.id);
            }
          }
        }
      }
      const moved = results.filter((r) => r.ok).length;
      const failed = results.filter((r) => !r.ok);
      if (moved > 0) insertNotification(db, "bulk_update_task_status", "Tasks moved", `${moved} task${moved === 1 ? "" : "s"} → ${col.name}`);
      return { moved, failed, targetColumnId, targetColumnName: col.name };
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
      db.prepare(`UPDATE notes SET linked_card_ids = ?, updated_at = ?, version = version + 1 WHERE id = ?`).run(newCardIds, now, noteId);
      db.prepare(`UPDATE task_cards SET linked_note_ids = ?, updated_at = ?, version = version + 1 WHERE id = ?`).run(newNoteIds, now, cardId);
      insertNotification(db, "link_note_to_task", "Note linked to task", `"${note.title}" linked to "${card.title}"`);
      return { noteId, cardId, linked: true };
    }

    case "get_note": {
      const note = snap.notes.find((n) => n.id === args.noteId);
      if (!note) return { error: "Note not found" };
      return {
        id: note.id, title: note.title, content: note.content,
        projectId: note.projectId, isPinned: note.isPinned,
        linkedNoteIds: note.linkedNoteIds, linkedCardIds: note.linkedCardIds,
        updatedAt: note.updatedAt, version: note.version ?? 0,
      };
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
      const columns = DEFAULT_COLUMNS.map((col) => {
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
        linkedNoteIds: card.linkedNoteIds, blockedByIds: card.blockedByIds ?? [],
        projectId: card.projectId, createdAt: card.createdAt, updatedAt: card.updatedAt, version: card.version ?? 0,
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
      // Clean up this card's ID from any other card's blocked_by_ids
      const now = ts();
      const affected = db.prepare(
        "SELECT id, blocked_by_ids FROM task_cards WHERE blocked_by_ids != '[]' AND id != ?"
      ).all(args.cardId) as { id: string; blocked_by_ids: string }[];
      for (const row of affected) {
        const ids: string[] = j2(row.blocked_by_ids);
        if (ids.includes(args.cardId as string)) {
          const updated = ids.filter((bid) => bid !== args.cardId);
          db.prepare("UPDATE task_cards SET blocked_by_ids = ?, updated_at = ? WHERE id = ?")
            .run(j(updated), now, row.id);
        }
      }
      db.prepare("DELETE FROM task_cards WHERE id = ?").run(args.cardId);
      insertNotification(db, "delete_task", "Task deleted", `"${card.title}" was deleted`);
      return { deleted: true, id: args.cardId, title: card.title };
    }

    case "block_task": {
      const card    = snap.cards.find((c) => c.id === args.cardId);
      const blocker = snap.cards.find((c) => c.id === args.blockerCardId);
      if (!card)    return { error: "Task not found" };
      if (!blocker) return { error: "Blocker task not found" };
      if (card.projectId !== blocker.projectId) return { error: "Cards must be in the same project" };
      if (args.cardId === args.blockerCardId)   return { error: "A card cannot block itself" };
      // Circular dep check
      const projectCards = snap.cards.filter((c) => c.projectId === card.projectId);
      const cardMap = new Map(projectCards.map((c) => [c.id, c]));
      function canReachMcp(from: string, target: string, visited = new Set<string>()): boolean {
        if (from === target) return true;
        if (visited.has(from)) return false;
        visited.add(from);
        const node = cardMap.get(from);
        if (!node) return false;
        return (node.blockedByIds ?? []).some((bid: string) => canReachMcp(bid, target, visited));
      }
      if (canReachMcp(args.blockerCardId as string, args.cardId as string, new Set())) {
        return { error: "Circular dependency detected" };
      }
      const nowB = ts();
      const row = db.prepare("SELECT blocked_by_ids FROM task_cards WHERE id = ?").get(args.cardId) as { blocked_by_ids: string } | undefined;
      if (!row) return { error: "Task not found in DB" };
      const ids: string[] = j2(row.blocked_by_ids);
      if (!ids.includes(args.blockerCardId as string)) {
        ids.push(args.blockerCardId as string);
        db.prepare("UPDATE task_cards SET blocked_by_ids = ?, updated_at = ?, version = version + 1 WHERE id = ?").run(j(ids), nowB, args.cardId);
      }
      insertNotification(db, "block_task", "Task blocked", `"${card.title}" is now blocked by "${blocker.title}"`);
      return { cardId: args.cardId, blockerCardId: args.blockerCardId, blocked: true };
    }

    case "unblock_task": {
      const card = snap.cards.find((c) => c.id === args.cardId);
      if (!card) return { error: "Task not found" };
      const nowU = ts();
      const rowU = db.prepare("SELECT blocked_by_ids FROM task_cards WHERE id = ?").get(args.cardId) as { blocked_by_ids: string } | undefined;
      if (!rowU) return { error: "Task not found in DB" };
      const idsU: string[] = j2(rowU.blocked_by_ids);
      const updated = idsU.filter((id) => id !== args.blockerCardId);
      db.prepare("UPDATE task_cards SET blocked_by_ids = ?, updated_at = ?, version = version + 1 WHERE id = ?").run(j(updated), nowU, args.cardId);
      return { cardId: args.cardId, blockerCardId: args.blockerCardId, unblocked: true };
    }

    case "list_ready_tasks": {
      // Cards that are active, not in a done column, and all blockers are resolved
      const projectFilter = args.projectId ? "AND tc.project_id = ?" : "";
      const params = args.projectId ? [args.projectId] : [];
      const candidates = db.prepare(`
        SELECT tc.*, bc.type as col_type, bc.name as col_name
        FROM task_cards tc
        JOIN board_columns bc ON tc.column_id = bc.id
        WHERE tc.archived_at IS NULL AND bc.type != 'done' ${projectFilter}
        ORDER BY tc."order"
      `).all(...params) as Array<{
        id: string; title: string; description: string; priority: string;
        due_date: string; column_id: string; project_id: string;
        blocked_by_ids: string; col_type: string; col_name: string;
      }>;
      // Build a lookup for blocker resolution
      const allProjectIds = [...new Set(candidates.map((c) => c.project_id))];
      const allCards = allProjectIds.flatMap((pid) =>
        db.prepare(`SELECT tc.id, tc.archived_at, tc.blocked_by_ids, bc.type as col_type
          FROM task_cards tc JOIN board_columns bc ON tc.column_id = bc.id WHERE tc.project_id = ?`
        ).all(pid) as Array<{ id: string; archived_at: string | null; col_type: string }>
      );
      const cardLookup = new Map(allCards.map((c) => [c.id, c]));
      function isResolvedMcp(blockerId: string): boolean {
        const b = cardLookup.get(blockerId);
        if (!b) return true;
        return b.archived_at !== null || b.col_type === "done";
      }
      const ready = candidates.filter((c) => {
        const ids: string[] = j2(c.blocked_by_ids);
        return ids.length === 0 || ids.every(isResolvedMcp);
      });
      return ready.map((c) => ({
        id: c.id, title: c.title, priority: c.priority, dueDate: c.due_date,
        columnId: c.column_id, columnName: c.col_name, projectId: c.project_id,
        blockedByIds: j2(c.blocked_by_ids),
      }));
    }

    case "update_task": {
      const { cardId, title, description, priority, dueDate, columnId, tagIds, expectedVersion: taskExpectedVersion } = args;
      const card = snap.cards.find((c) => c.id === cardId);
      if (!card) return { error: "Task not found" };
      if (taskExpectedVersion !== undefined) {
        const currentVersion = getCardVersion(db, cardId as string);
        if (currentVersion !== null && currentVersion !== (taskExpectedVersion as number)) {
          return { error: `Version conflict: task has been modified (expected v${taskExpectedVersion as number}, got v${currentVersion}). Fetch the latest state before retrying.` };
        }
      }
      const now = ts();
      db.transaction(() => {
        db.prepare(`
          UPDATE task_cards SET
            column_id   = COALESCE(?, column_id),
            title       = COALESCE(?, title),
            description = COALESCE(?, description),
            priority    = COALESCE(?, priority),
            due_date    = COALESCE(?, due_date),
            tag_ids     = COALESCE(?, tag_ids),
            updated_at  = ?,
            version     = version + 1
          WHERE id = ?
        `).run(
          columnId ?? null, title ?? null, description ?? null,
          priority ?? null, dueDate ?? null,
          tagIds != null ? (Array.isArray(tagIds) ? j(tagIds) : tagIds) : null,
          now, cardId
        );
        insertNotification(db, "update_task", "Task updated", `"${title ?? card.title}" was updated`);
      })();
      const updated = db.prepare("SELECT * FROM task_cards WHERE id = ?").get(cardId) as Record<string, unknown> | undefined;
      return updated ?? { error: "Task not found after update" };
    }

    case "archive_task": {
      const { cardId } = args;
      const card = snap.cards.find((c) => c.id === cardId);
      if (!card) return { error: "Task not found" };
      if (card.archivedAt) return { error: "Task is already archived" };
      const now = ts();
      db.prepare("UPDATE task_cards SET archived_at = ?, updated_at = ?, version = version + 1 WHERE id = ?").run(now, now, cardId);
      insertNotification(db, "archive_task", "Task archived", `"${card.title}" was archived`);
      return { ok: true, cardId, archivedAt: now };
    }

    case "restore_task": {
      const { cardId } = args;
      // Must query DB directly — archived cards are filtered out of snap.cards
      const row = db.prepare("SELECT * FROM task_cards WHERE id = ?").get(cardId) as Record<string, unknown> | undefined;
      if (!row) return { error: "Task not found" };
      if (!row.archived_at) return { error: "Task is not archived" };
      const now = ts();
      db.prepare("UPDATE task_cards SET archived_at = NULL, updated_at = ?, version = version + 1 WHERE id = ?").run(now, cardId);
      insertNotification(db, "restore_task", "Task restored", `"${row.title as string}" was restored`);
      return { ok: true, cardId, title: row.title };
    }

    case "update_project": {
      const { projectId, name, description, status, priority, icon } = args;
      const project = snap.projects.find((p) => p.id === projectId);
      if (!project) return { error: "Project not found" };
      const now = ts();
      db.prepare(`
        UPDATE projects SET
          name        = COALESCE(?, name),
          description = COALESCE(?, description),
          status      = COALESCE(?, status),
          priority    = COALESCE(?, priority),
          icon        = COALESCE(?, icon),
          updated_at  = ?
        WHERE id = ?
      `).run(name ?? null, description ?? null, status ?? null, priority ?? null, icon ?? null, now, projectId);
      const updated = db.prepare("SELECT * FROM projects WHERE id = ?").get(projectId) as Record<string, unknown> | undefined;
      insertNotification(db, "update_project", "Project updated", `"${name ?? project.name}" was updated`);
      return updated ?? { error: "Project not found after update" };
    }

    case "create_tag": {
      const { workspaceId, name, color } = args;
      if (!workspaceId || !name) return { error: "workspaceId and name are required" };
      const tagId = newId();
      const tag = { id: tagId, workspaceId: workspaceId as string, name: name as string, color: (color as string) ?? "#6366f1" };
      db.prepare("INSERT INTO tags (id, workspace_id, name, color) VALUES (?, ?, ?, ?)").run(tag.id, tag.workspaceId, tag.name, tag.color);
      insertNotification(db, "create_tag", "Tag created", `"${tag.name}" tag created`);
      return { id: tagId, workspaceId: tag.workspaceId, name: tag.name, color: tag.color };
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
        .map((n) => ({ id: n.id, title: n.title, projectId: n.projectId, folder: n.folder ?? "", isPinned: n.isPinned, updatedAt: n.updatedAt }));
    }

    case "list_tasks": {
      const includeArchived = !!(args.includeArchived);
      const cols = snap.columns.filter((c) => !args.columnType || c.type === args.columnType)
        .filter((c) => !args.projectId || c.projectId === args.projectId);
      if (includeArchived) {
        // Query DB directly for archived cards — they're filtered out of snap.cards
        const projectFilter = args.projectId ? `AND tc.project_id = ?` : "";
        const rows = db.prepare(
          `SELECT tc.*, bc.name as col_name, bc.type as col_type
           FROM task_cards tc
           JOIN board_columns bc ON tc.column_id = bc.id
           WHERE tc.archived_at IS NOT NULL ${projectFilter}
           ORDER BY tc.archived_at DESC`
        ).all(...(args.projectId ? [args.projectId] : [])) as Array<Record<string, unknown>>;
        return {
          archived: rows.map((r) => ({
            id: r.id, title: r.title, priority: r.priority,
            description: r.description, archivedAt: r.archived_at,
            columnName: r.col_name, columnType: r.col_type,
          })),
          note: "These tasks are archived. Use restore_task to bring one back to the board.",
        };
      }
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

    case "resolve_project": {
      // Find a project by exact or fuzzy name match — returns projectId so agents
      // don't need to call get_cairn_context just to look up an ID.
      const { workspaceId, name: query } = args;
      const candidates = snap.projects.filter((p) =>
        !p.archivedAt && (!workspaceId || p.workspaceId === workspaceId)
      );
      const needle = (query as string).toLowerCase().trim();
      // 1. exact match (case-insensitive)
      let match = candidates.find((p) => p.name.toLowerCase() === needle);
      // 2. starts-with
      if (!match) match = candidates.find((p) => p.name.toLowerCase().startsWith(needle));
      // 3. contains
      if (!match) match = candidates.find((p) => p.name.toLowerCase().includes(needle));
      if (!match) return { error: `No project found matching "${query}"`, candidates: candidates.map((p) => ({ id: p.id, name: p.name })) };
      const columns = snap.columns
        .filter((c) => c.projectId === match!.id)
        .sort((a, b) => a.order - b.order)
        .map((c) => ({ id: c.id, name: c.name, type: c.type }));
      return { id: match.id, name: match.name, workspaceId: match.workspaceId, status: match.status, columns };
    }

    case "ensure_note": {
      // Idempotent: finds a note by title+projectId and updates it, or creates it.
      // Prevents duplicate notes when agents re-run (e.g. syncing a README).
      const { projectId, title, content, tagIds: ensureTagIds, isPinned: ensureIsPinned } = args;
      const project = snap.projects.find((p) => p.id === projectId);
      if (!project) return { error: "Project not found" };
      const existing = snap.notes.find(
        (n) => !n.archivedAt && n.projectId === projectId && n.title === title
      );
      const now = ts();
      const markdown = (content as string | undefined) ?? "";
      const ensureResolvedTagIds = Array.isArray(ensureTagIds) ? ensureTagIds as string[] : undefined;
      const ensureResolvedIsPinned = typeof ensureIsPinned === "boolean" ? ensureIsPinned : undefined;
      const ensureFolder = typeof args.folder === "string" ? args.folder : undefined;
      const ensureNoteId = existing?.id ?? newId();
      lockNote(db, ensureNoteId);
      try {
        if (existing) {
          const tagIdsJson = ensureResolvedTagIds ? j(ensureResolvedTagIds) : null;
          const pinnedVal = ensureResolvedIsPinned !== undefined ? (ensureResolvedIsPinned ? 1 : 0) : null;
          const folderVal = ensureFolder !== undefined ? ensureFolder : null;
          const updatedFolder = ensureFolder ?? (existing.folder as string) ?? "";
          db.transaction(() => {
            db.prepare(`UPDATE notes SET content = ?, content_text = ?, tag_ids = COALESCE(?, tag_ids), is_pinned = COALESCE(?, is_pinned), folder = COALESCE(?, folder), updated_at = ?, version = version + 1 WHERE id = ?`)
              .run(markdown, stripMarkdown(markdown), tagIdsJson, pinnedVal, folderVal, now, existing.id);
            insertNotification(db, "update_note", "Note updated", `"${title}" was updated (ensure_note)`);
          })();
          writeNoteFile(workspacePath, {
            id: existing.id, projectId, workspaceId: existing.workspaceId as string,
            title: existing.title as string, content: markdown,
            tagIds: ensureResolvedTagIds ?? existing.tagIds as string[], linkedNoteIds: existing.linkedNoteIds as string[],
            linkedCardIds: existing.linkedCardIds as string[], isPinned: ensureResolvedIsPinned ?? existing.isPinned as boolean,
            folder: updatedFolder,
            createdAt: existing.createdAt as string, updatedAt: now,
            archivedAt: existing.archivedAt as string | undefined,
            projectName: project.name,
          });
          return { id: existing.id, title, action: "updated", updatedAt: now };
        } else {
          const newTagIds = ensureResolvedTagIds ?? [];
          const newIsPinned = ensureResolvedIsPinned ?? false;
          const newFolder = ensureFolder ?? "";
          db.transaction(() => {
            db.prepare(`
              INSERT INTO notes (id, project_id, workspace_id, title, content, content_text,
                tag_ids, linked_note_ids, linked_card_ids, is_pinned, type, folder, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, '[]', '[]', ?, 'note', ?, ?, ?)
            `).run(ensureNoteId, projectId, project.workspaceId, title, markdown, stripMarkdown(markdown), j(newTagIds), newIsPinned ? 1 : 0, newFolder, now, now);
            insertNotification(db, "create_note", "Note created", `"${title}" added to ${project.name}${newFolder ? ` (${newFolder})` : ""} (ensure_note)`);
          })();
          writeNoteFile(workspacePath, {
            id: ensureNoteId, projectId, workspaceId: project.workspaceId, title, content: markdown,
            tagIds: newTagIds, linkedNoteIds: [], linkedCardIds: [], isPinned: newIsPinned,
            folder: newFolder, createdAt: now, updatedAt: now, projectName: project.name,
          });
          return { id: ensureNoteId, title, folder: newFolder, action: "created", createdAt: now };
        }
      } finally {
        unlockNote(db, ensureNoteId);
      }
    }

    case "append_to_note": {
      // Appends content to the end of a note without requiring the agent to
      // fetch and re-send the full body.
      const { noteId, content: appendContent, separator = "\n\n", expectedVersion: appendExpectedVersion } = args;
      const note = snap.notes.find((n) => n.id === noteId);
      if (!note) return { error: "Note not found" };
      if (appendExpectedVersion !== undefined) {
        const currentVersion = getNoteVersion(db, noteId as string);
        if (currentVersion !== null && currentVersion !== (appendExpectedVersion as number)) {
          return { error: `Version conflict: note has been modified (expected v${appendExpectedVersion as number}, got v${currentVersion}). Fetch the latest content before retrying.` };
        }
      }
      const now = ts();
      const existingContent = (note.content as string) ?? "";
      const newContent = existingContent
        ? existingContent + (separator as string) + (appendContent as string)
        : (appendContent as string);
      lockNote(db, noteId as string);
      try {
        const proj = snap.projects.find((p) => p.id === note.projectId);
        db.transaction(() => {
          db.prepare(`UPDATE notes SET content = ?, content_text = ?, updated_at = ?, version = version + 1 WHERE id = ?`)
            .run(newContent, stripMarkdown(newContent), now, noteId);
          insertNotification(db, "update_note", "Note updated", `Content appended to "${note.title}"`);
        })();
        writeNoteFile(workspacePath, {
          id: noteId, projectId: note.projectId as string, workspaceId: note.workspaceId as string,
          title: note.title as string, content: newContent,
          tagIds: note.tagIds as string[], linkedNoteIds: note.linkedNoteIds as string[],
          linkedCardIds: note.linkedCardIds as string[], isPinned: note.isPinned as boolean,
          createdAt: note.createdAt as string, updatedAt: now,
          archivedAt: note.archivedAt as string | undefined,
          projectName: proj?.name ?? note.projectId as string,
        });
        return { id: noteId, title: note.title, updatedAt: now, newLength: newContent.length };
      } finally {
        unlockNote(db, noteId as string);
      }
    }

    case "patch_note": {
      // Surgical in-place replacement — agent sends oldString + newString,
      // server does the substitution. Avoids re-sending full note content.
      const { noteId, oldString, newString: replacement, replaceAll: all = false, expectedVersion: patchExpectedVersion } = args as {
        noteId: string; oldString: string; newString: string; replaceAll?: boolean; expectedVersion?: number;
      };
      const note = snap.notes.find((n) => n.id === noteId);
      if (!note) return { error: "Note not found" };
      if (patchExpectedVersion !== undefined) {
        const currentVersion = getNoteVersion(db, noteId);
        if (currentVersion !== null && currentVersion !== patchExpectedVersion) {
          return { error: `Version conflict: note has been modified (expected v${patchExpectedVersion}, got v${currentVersion}). Fetch the latest content before retrying.` };
        }
      }
      const existing = (note.content as string) ?? "";
      const count = existing.split(oldString).length - 1;
      if (count === 0) return { error: "oldString not found in note content" };
      if (count > 1 && !all) return { error: `oldString matches ${count} times — set replaceAll: true to replace all, or provide more surrounding context to make it unique` };
      const now = ts();
      const newContent = all ? existing.split(oldString).join(replacement) : existing.replace(oldString, replacement);
      lockNote(db, noteId);
      try {
        const proj = snap.projects.find((p) => p.id === note.projectId);
        db.transaction(() => {
          db.prepare(`UPDATE notes SET content = ?, content_text = ?, updated_at = ?, version = version + 1 WHERE id = ?`)
            .run(newContent, stripMarkdown(newContent), now, noteId);
          insertNotification(db, "update_note", "Note updated", `Patch applied to "${note.title}"`);
        })();
        writeNoteFile(workspacePath, {
          id: noteId, projectId: note.projectId as string, workspaceId: note.workspaceId as string,
          title: note.title as string, content: newContent,
          tagIds: note.tagIds as string[], linkedNoteIds: note.linkedNoteIds as string[],
          linkedCardIds: note.linkedCardIds as string[], isPinned: note.isPinned as boolean,
          createdAt: note.createdAt as string, updatedAt: now,
          archivedAt: note.archivedAt as string | undefined,
          projectName: proj?.name ?? note.projectId as string,
        });
        return { id: noteId, title: note.title, updatedAt: now, replacements: all ? count : 1 };
      } finally {
        unlockNote(db, noteId);
      }
    }

    // ── Idea Flow tools ───────────────────────────────────────────────────────

    case "get_idea_flow": {
      const project = snap.projects.find((p) => p.id === args.projectId);
      if (!project) return { error: "Project not found" };
      // Get or create the flow
      const existingFlow = db.prepare("SELECT * FROM idea_flows WHERE project_id = ?").get(args.projectId) as
        | { id: string; project_id: string; created_at: string; updated_at: string } | undefined;
      let flowId: string;
      if (existingFlow) {
        flowId = existingFlow.id;
      } else {
        flowId = newId();
        const now = ts();
        db.prepare("INSERT INTO idea_flows (id, project_id, created_at, updated_at) VALUES (?, ?, ?, ?)")
          .run(flowId, args.projectId, now, now);
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rawNodes = db.prepare("SELECT * FROM idea_flow_nodes WHERE flow_id = ? ORDER BY created_at").all(flowId) as any[];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rawEdges = db.prepare("SELECT * FROM idea_flow_edges WHERE flow_id = ? ORDER BY created_at").all(flowId) as any[];
      const nodes = rawNodes.map((row) => {
        let data: Record<string, unknown> = {};
        try { data = JSON.parse(row.data); } catch { /* empty */ }
        const node = {
          id: row.id as string,
          type: row.type as string,
          position: { x: row.x as number, y: row.y as number },
          width: row.width as number | null,
          height: row.height as number | null,
          parentId: row.parent_id as string | null,
          data,
        };
        // Resolve note_ref
        if (node.type === "note_ref" && data.noteId) {
          const noteRow = db.prepare("SELECT id, title, content_text FROM notes WHERE id = ?").get(data.noteId) as
            | { id: string; title: string; content_text: string } | undefined;
          if (noteRow) {
            return { ...node, data: { ...data, resolvedTitle: noteRow.title, resolvedSnippet: noteRow.content_text?.slice(0, 200) ?? "" } };
          }
        }
        // Resolve task_ref
        if (node.type === "task_ref" && data.cardId) {
          const cardRow = db.prepare(`
            SELECT tc.id, tc.title, tc.priority, bc.name as column_name
            FROM task_cards tc LEFT JOIN board_columns bc ON tc.column_id = bc.id
            WHERE tc.id = ?
          `).get(data.cardId) as { id: string; title: string; priority: string; column_name: string } | undefined;
          if (cardRow) {
            return { ...node, data: { ...data, resolvedTitle: cardRow.title, resolvedPriority: cardRow.priority, resolvedColumnName: cardRow.column_name } };
          }
        }
        return node;
      });
      const edges = rawEdges.map((row) => ({
        id: row.id as string,
        source: row.source_node_id as string,
        target: row.target_node_id as string,
        label: row.label as string | null,
      }));
      // Build group position map for absolute coord computation
      const groupPos = new Map<string, { x: number; y: number }>();
      for (const n of nodes) {
        if (n.type === "group") groupPos.set(n.id, { x: n.position.x, y: n.position.y });
      }

      // Enrich nodes with absoluteX/absoluteY (children use relative coords in DB)
      const enriched = nodes.map((n) => {
        const parent = n.parentId ? groupPos.get(n.parentId) : undefined;
        return {
          ...n,
          absoluteX: parent ? parent.x + n.position.x : n.position.x,
          absoluteY: parent ? parent.y + n.position.y : n.position.y,
        };
      });

      // Spatial summary uses absolute coordinates
      const contentNodes = enriched.filter((n) => n.type !== "group");
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const n of contentNodes) {
        const w = n.width ?? 220;
        const h = n.height ?? 80;
        minX = Math.min(minX, n.absoluteX);
        minY = Math.min(minY, n.absoluteY);
        maxX = Math.max(maxX, n.absoluteX + w);
        maxY = Math.max(maxY, n.absoluteY + h);
      }
      const hasNodes = contentNodes.length > 0;

      // Per-group free slots (relative to group top-left)
      const groupSlots: Record<string, { x: number; y: number }> = {};
      for (const g of enriched.filter((n) => n.type === "group")) {
        const children = enriched.filter((n) => n.parentId === g.id);
        if (children.length === 0) {
          groupSlots[g.id] = { x: 40, y: 40 };
        } else {
          let childMaxY = -Infinity;
          for (const c of children) childMaxY = Math.max(childMaxY, c.position.y + (c.height ?? 80));
          groupSlots[g.id] = { x: 40, y: Math.round(childMaxY + 20) };
        }
      }

      const spatial = {
        bounds: hasNodes ? { x: minX, y: minY, width: maxX - minX, height: maxY - minY } : null,
        nextPosition: hasNodes ? { x: Math.round(minX), y: Math.round(maxY + 120) } : { x: 40, y: 40 },
        groupSlots,
      };
      return { flowId, projectId: args.projectId, nodes: enriched, edges, spatial };
    }

    case "create_idea_flow_node": {
      const project = snap.projects.find((p) => p.id === args.projectId);
      if (!project) return { error: "Project not found" };
      const validTypes = ["idea", "note_ref", "task_ref", "group", "url", "ai_summary"];
      if (!validTypes.includes(args.type as string)) return { error: `Invalid node type. Must be one of: ${validTypes.join(", ")}` };
      // Get or create flow
      const existingFlow = db.prepare("SELECT id FROM idea_flows WHERE project_id = ?").get(args.projectId) as { id: string } | undefined;
      let flowId: string;
      if (existingFlow) {
        flowId = existingFlow.id;
      } else {
        flowId = newId();
        const fnow = ts();
        db.prepare("INSERT INTO idea_flows (id, project_id, created_at, updated_at) VALUES (?, ?, ?, ?)")
          .run(flowId, args.projectId, fnow, fnow);
      }
      const nodeId = newId();
      const now = ts();
      const dataJson = JSON.stringify(args.data ?? {});
      db.prepare(`
        INSERT INTO idea_flow_nodes (id, flow_id, type, x, y, width, height, parent_id, data, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(nodeId, flowId, args.type, args.x ?? 0, args.y ?? 0, args.width ?? null, args.height ?? null, args.parentId ?? null, dataJson, now, now);
      insertNotification(db, "create_idea_flow_node", "Idea Flow updated", `Added ${args.type} node to flow`);

      // Optionally create edges inline
      const createdEdges: { id: string; source: string; target: string; label: string | null }[] = [];
      if (Array.isArray(args.edges)) {
        for (const edgeDef of args.edges as Array<{ targetNodeId?: string; sourceNodeId?: string; label?: string }>) {
          const edgeId = newId();
          const edgeNow = ts();
          const src = edgeDef.sourceNodeId ?? nodeId;
          const tgt = edgeDef.targetNodeId ?? nodeId;
          db.prepare(`
            INSERT OR IGNORE INTO idea_flow_edges (id, flow_id, source_node_id, target_node_id, label, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
          `).run(edgeId, flowId, src, tgt, edgeDef.label ?? null, edgeNow);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const created = db.prepare("SELECT * FROM idea_flow_edges WHERE id = ?").get(edgeId) as any;
          if (created) createdEdges.push({ id: edgeId, source: src, target: tgt, label: edgeDef.label ?? null });
        }
      }

      return { id: nodeId, flowId, type: args.type, position: { x: args.x ?? 0, y: args.y ?? 0 }, data: args.data ?? {}, createdAt: now, edges: createdEdges };
    }

    case "update_idea_flow_node": {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const existingRow = db.prepare("SELECT * FROM idea_flow_nodes WHERE id = ?").get(args.nodeId) as any;
      if (!existingRow) return { error: "Node not found" };
      let existingData: Record<string, unknown> = {};
      try { existingData = JSON.parse(existingRow.data); } catch { /* empty */ }
      const mergedData = args.data !== undefined ? { ...existingData, ...(args.data as Record<string, unknown>) } : existingData;
      const now = ts();
      db.prepare(`
        UPDATE idea_flow_nodes SET
          x          = COALESCE(?, x),
          y          = COALESCE(?, y),
          width      = COALESCE(?, width),
          height     = COALESCE(?, height),
          data       = ?,
          updated_at = ?
        WHERE id = ?
      `).run(
        args.x !== undefined ? args.x : null,
        args.y !== undefined ? args.y : null,
        args.width !== undefined ? args.width : null,
        args.height !== undefined ? args.height : null,
        JSON.stringify(mergedData),
        now,
        args.nodeId,
      );
      insertNotification(db, "update_idea_flow_node", "Idea Flow updated", `Node updated`);
      return { id: args.nodeId, data: mergedData, updatedAt: now };
    }

    case "delete_idea_flow_node": {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const existingNode = db.prepare("SELECT * FROM idea_flow_nodes WHERE id = ?").get(args.nodeId) as any;
      if (!existingNode) return { error: "Node not found" };
      db.prepare("DELETE FROM idea_flow_nodes WHERE id = ?").run(args.nodeId);
      insertNotification(db, "delete_idea_flow_node", "Idea Flow updated", `Node removed from flow`);
      return { deleted: true, id: args.nodeId };
    }

    case "create_idea_flow_edge": {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const srcNode = db.prepare("SELECT id, flow_id FROM idea_flow_nodes WHERE id = ?").get(args.sourceNodeId) as any;
      if (!srcNode) return { error: "Source node not found" };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const tgtNode = db.prepare("SELECT id FROM idea_flow_nodes WHERE id = ?").get(args.targetNodeId) as any;
      if (!tgtNode) return { error: "Target node not found" };
      const edgeId = newId();
      const now = ts();
      db.prepare(`
        INSERT OR IGNORE INTO idea_flow_edges (id, flow_id, source_node_id, target_node_id, label, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(edgeId, srcNode.flow_id, args.sourceNodeId, args.targetNodeId, args.label ?? null, now);
      // Check if INSERT OR IGNORE silently skipped (duplicate edge)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const created = db.prepare("SELECT * FROM idea_flow_edges WHERE id = ?").get(edgeId) as any;
      if (!created) {
        const existing = db.prepare("SELECT id FROM idea_flow_edges WHERE flow_id = ? AND source_node_id = ? AND target_node_id = ?")
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .get(srcNode.flow_id, args.sourceNodeId, args.targetNodeId) as any;
        return { id: existing?.id ?? null, source: args.sourceNodeId, target: args.targetNodeId, label: args.label ?? null, note: "Edge already exists" };
      }
      insertNotification(db, "create_idea_flow_edge", "Idea Flow updated", `Nodes connected`);
      return { id: edgeId, source: args.sourceNodeId, target: args.targetNodeId, label: args.label ?? null, createdAt: now };
    }

    case "delete_idea_flow_edge": {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const existingEdge = db.prepare("SELECT * FROM idea_flow_edges WHERE id = ?").get(args.edgeId) as any;
      if (!existingEdge) return { error: "Edge not found" };
      db.prepare("DELETE FROM idea_flow_edges WHERE id = ?").run(args.edgeId);
      insertNotification(db, "delete_idea_flow_edge", "Idea Flow updated", `Connection removed`);
      return { deleted: true, id: args.edgeId };
    }

    case "layout_idea_flow": {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const flowRow = db.prepare("SELECT id FROM idea_flows WHERE project_id = ?").get(args.projectId) as any;
      if (!flowRow) return { arranged: 0 };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rawNodes = db.prepare("SELECT * FROM idea_flow_nodes WHERE flow_id = ?").all(flowRow.id) as any[];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rawEdges = db.prepare("SELECT * FROM idea_flow_edges WHERE flow_id = ?").all(flowRow.id) as any[];
      if (rawNodes.length === 0) return { arranged: 0 };

      const dir = (args.direction as string) === "TB" ? "TB" : "LR";
      const NODE_W = 220, NODE_H = 80, GROUP_PADDING = 48, GROUP_PADDING_TOP = 56, GROUP_GAP = 80;

      function makeG(rankdir: string, nodesep: number, ranksep: number) {
        const g = new dagre.graphlib.Graph();
        g.setDefaultEdgeLabel(() => ({}));
        g.setGraph({ rankdir, nodesep, ranksep, marginx: 40, marginy: 40 });
        return g;
      }

      const groups    = rawNodes.filter((n: { type: string }) => n.type === "group");
      const ungrouped = rawNodes.filter((n: { type: string; parent_id: string | null }) => n.type !== "group" && !n.parent_id);
      const grouped   = rawNodes.filter((n: { type: string; parent_id: string | null }) => n.type !== "group" && !!n.parent_id);

      const now = ts();
      const posStmt  = db.prepare("UPDATE idea_flow_nodes SET x = ?, y = ?, updated_at = ? WHERE id = ?");
      const sizeStmt = db.prepare("UPDATE idea_flow_nodes SET x = ?, y = ?, width = ?, height = ?, updated_at = ? WHERE id = ?");
      const groupSizes = new Map<string, { width: number; height: number }>();

      // Phase 1: layout children inside each group
      for (const group of groups) {
        const children = grouped.filter((n: { parent_id: string }) => n.parent_id === group.id);
        if (children.length === 0) {
          groupSizes.set(group.id, { width: group.width ?? 320, height: group.height ?? 200 });
          continue;
        }
        const childIds = new Set(children.map((n: { id: string }) => n.id));
        const g = makeG(dir, 60, 120);
        for (const c of children) g.setNode(c.id, { width: NODE_W, height: NODE_H });
        for (const e of rawEdges) {
          if (e.source_node_id !== e.target_node_id && childIds.has(e.source_node_id) && childIds.has(e.target_node_id)) {
            g.setEdge(e.source_node_id, e.target_node_id);
          }
        }
        dagre.layout(g);
        let innerMaxX = 0, innerMaxY = 0;
        for (const c of children) {
          const pos = g.node(c.id);
          if (!pos) continue;
          const rx = pos.x - pos.width / 2 + GROUP_PADDING;
          const ry = pos.y - pos.height / 2 + GROUP_PADDING_TOP;
          innerMaxX = Math.max(innerMaxX, rx + pos.width);
          innerMaxY = Math.max(innerMaxY, ry + pos.height);
          posStmt.run(rx, ry, now, c.id);
        }
        const gw = innerMaxX + GROUP_PADDING;
        const gh = innerMaxY + GROUP_PADDING;
        groupSizes.set(group.id, { width: gw, height: gh });
      }

      // Phase 2: layout groups + ungrouped together
      const topLevel = [...groups, ...ungrouped];
      if (topLevel.length > 0) {
        const g = makeG(dir, GROUP_GAP, GROUP_GAP + 40);
        for (const n of topLevel) {
          const size = groupSizes.get(n.id);
          g.setNode(n.id, { width: size?.width ?? NODE_W, height: size?.height ?? NODE_H });
        }
        const topIds = new Set(topLevel.map((n: { id: string }) => n.id));
        for (const e of rawEdges) {
          if (e.source_node_id !== e.target_node_id && topIds.has(e.source_node_id) && topIds.has(e.target_node_id)) {
            g.setEdge(e.source_node_id, e.target_node_id);
          }
        }
        dagre.layout(g);
        for (const n of topLevel) {
          const pos = g.node(n.id);
          if (!pos) continue;
          const x = pos.x - pos.width / 2;
          const y = pos.y - pos.height / 2;
          if (n.type === "group") {
            const size = groupSizes.get(n.id)!;
            sizeStmt.run(x, y, size.width, size.height, now, n.id);
          } else {
            posStmt.run(x, y, now, n.id);
          }
        }
      }

      insertNotification(db, "layout_idea_flow", "Idea Flow updated", `Auto-arranged ${rawNodes.length} nodes`);
      return { arranged: rawNodes.length, direction: dir };
    }

    case "get_knowledge_graph": {
      const { workspaceId, projectIds, includeAuto = true } = args;
      if (!workspaceId) return { error: "workspaceId is required" };

      // Get scoped projects
      const allProjects = db.prepare(
        "SELECT id, name, description, status, priority FROM projects WHERE workspace_id = ? AND archived_at IS NULL"
      ).all(workspaceId) as Record<string, unknown>[];

      const filteredProjects = projectIds && Array.isArray(projectIds) && projectIds.length > 0
        ? allProjects.filter((p) => (projectIds as string[]).includes(p.id as string))
        : allProjects;

      const projIds = filteredProjects.map((p) => p.id as string);
      if (projIds.length === 0) return { nodes: [], edges: [] };
      const ph = projIds.map(() => "?").join(",");

      const nodes: unknown[] = [];
      const edges: unknown[] = [];
      let seq = 0;
      const nodeSet = new Set<string>();

      function eid(t: string, s: string, g: string) { return `${t}:${s}:${g}:${seq++}`; }
      function pj(v: unknown): string[] { try { return JSON.parse(v as string ?? "[]") as string[]; } catch { return []; } }

      // Projects
      for (const p of filteredProjects) {
        nodeSet.add(p.id as string);
        nodes.push({ id: p.id, type: "project", title: p.name, meta: { status: p.status, priority: p.priority } });
      }

      // Notes
      const notes = db.prepare(
        `SELECT id, project_id, title, content_text, tag_ids, linked_note_ids, linked_card_ids FROM notes WHERE project_id IN (${ph}) AND archived_at IS NULL`
      ).all(...projIds) as Record<string, unknown>[];
      for (const n of notes) {
        nodeSet.add(n.id as string);
        nodes.push({ id: n.id, type: "note", title: n.title, projectId: n.project_id,
          meta: { snippet: ((n.content_text as string) || "").slice(0, 120) } });
        edges.push({ id: eid("pm", n.project_id as string, n.id as string), source: n.project_id, target: n.id, type: "project-member" });
        for (const lid of pj(n.linked_note_ids)) {
          if ((n.id as string) < lid)
            edges.push({ id: eid("nn", n.id as string, lid), source: n.id, target: lid, type: "note-note", label: "linked" });
        }
      }

      // Cards
      const cards = db.prepare(
        `SELECT id, project_id, title, description, tag_ids, linked_note_ids, assignee, priority FROM task_cards WHERE project_id IN (${ph}) AND archived_at IS NULL`
      ).all(...projIds) as Record<string, unknown>[];
      for (const c of cards) {
        nodeSet.add(c.id as string);
        nodes.push({ id: c.id, type: "card", title: c.title, projectId: c.project_id,
          meta: { priority: c.priority, assignee: c.assignee, snippet: ((c.description as string) || "").slice(0, 120) } });
        edges.push({ id: eid("pm", c.project_id as string, c.id as string), source: c.project_id, target: c.id, type: "project-member" });
        for (const nid of pj(c.linked_note_ids))
          edges.push({ id: eid("nc", nid, c.id as string), source: nid, target: c.id, type: "note-card", label: "linked" });
      }

      // Tags
      const usedTagIds = new Set<string>();
      for (const n of notes) for (const t of pj(n.tag_ids)) usedTagIds.add(t);
      for (const c of cards) for (const t of pj(c.tag_ids)) usedTagIds.add(t);
      if (usedTagIds.size > 0) {
        const tph = [...usedTagIds].map(() => "?").join(",");
        const tags = db.prepare(`SELECT id, name, color FROM tags WHERE id IN (${tph})`).all(...usedTagIds) as Record<string, unknown>[];
        for (const t of tags) {
          nodeSet.add(t.id as string);
          nodes.push({ id: t.id, type: "tag", title: t.name, meta: { color: t.color } });
        }
        for (const n of notes) for (const tid of pj(n.tag_ids))
          if (nodeSet.has(tid)) edges.push({ id: eid("tm", n.id as string, tid), source: n.id, target: tid, type: "tag-member" });
        for (const c of cards) for (const tid of pj(c.tag_ids))
          if (nodeSet.has(tid)) edges.push({ id: eid("tm", c.id as string, tid), source: c.id, target: tid, type: "tag-member" });
      }

      // IdeaFlow explicit edges
      const flows = db.prepare(`SELECT id FROM idea_flows WHERE project_id IN (${ph})`).all(...projIds) as Record<string, unknown>[];
      for (const fl of flows) {
        const fEdges = db.prepare(
          `SELECT fe.id, sn.data as sdata, tn.data as tdata, fe.label
           FROM idea_flow_edges fe
           JOIN idea_flow_nodes sn ON sn.id = fe.source_node_id
           JOIN idea_flow_nodes tn ON tn.id = fe.target_node_id
           WHERE fe.flow_id = ?`
        ).all(fl.id) as Record<string, unknown>[];
        for (const fe of fEdges) {
          const sd = JSON.parse((fe.sdata as string) || "{}") as Record<string, string>;
          const td = JSON.parse((fe.tdata as string) || "{}") as Record<string, string>;
          const src = sd.noteId || sd.cardId;
          const tgt = td.noteId || td.cardId;
          if (src && tgt && nodeSet.has(src) && nodeSet.has(tgt))
            edges.push({ id: eid("fe", src, tgt), source: src, target: tgt, type: "flow-edge", label: fe.label || "connected" });
        }
      }

      // Auto relationships
      if (includeAuto && nodeSet.size > 0) {
        const autoRows = db.prepare(
          "SELECT source_id, target_id, type, weight FROM relationship_cache WHERE type IN ('co-mention','keyword','assignee')"
        ).all() as Record<string, unknown>[];
        for (const r of autoRows) {
          if (nodeSet.has(r.source_id as string) && nodeSet.has(r.target_id as string))
            edges.push({ id: eid(r.type as string, r.source_id as string, r.target_id as string), source: r.source_id, target: r.target_id, type: r.type, weight: r.weight });
        }
      }

      insertNotification(db, "get_knowledge_graph", "Knowledge graph retrieved", `${nodes.length} nodes, ${edges.length} edges`);
      return { nodes, edges };
    }

    case "get_neighbors": {
      const { workspaceId, nodeId, depth = 1 } = args;
      if (!workspaceId || !nodeId) return { error: "workspaceId and nodeId are required" };
      // Build full graph then BFS
      const fullResult = executeTool(db, workspacePath, "get_knowledge_graph", { workspaceId, includeAuto: true });
      const graph = fullResult as { nodes: Record<string, unknown>[]; edges: Record<string, unknown>[] };
      if (!graph.nodes) return { center: null, neighbours: [] };

      const center = graph.nodes.find((n) => n.id === nodeId) ?? null;
      if (!center) return { center: null, neighbours: [] };

      const adj = new Map<string, { nodeId: string; edge: Record<string, unknown> }[]>();
      for (const e of graph.edges) {
        const s = e.source as string, t = e.target as string;
        if (!adj.has(s)) adj.set(s, []);
        if (!adj.has(t)) adj.set(t, []);
        adj.get(s)!.push({ nodeId: t, edge: e });
        adj.get(t)!.push({ nodeId: s, edge: e });
      }

      const visited = new Set<string>([nodeId]);
      const queue: { id: string; dist: number; edge: Record<string, unknown> }[] = [];
      const neighbours: unknown[] = [];
      for (const a of adj.get(nodeId) ?? []) {
        if (!visited.has(a.nodeId)) { visited.add(a.nodeId); queue.push({ id: a.nodeId, dist: 1, edge: a.edge }); }
      }
      while (queue.length > 0) {
        const item = queue.shift()!;
        const node = graph.nodes.find((n) => n.id === item.id);
        if (!node) continue;
        neighbours.push({ node, edge: item.edge, distance: item.dist });
        if (item.dist < (depth as number)) {
          for (const a of adj.get(item.id) ?? []) {
            if (!visited.has(a.nodeId)) { visited.add(a.nodeId); queue.push({ id: a.nodeId, dist: item.dist + 1, edge: a.edge }); }
          }
        }
      }
      return { center, neighbours };
    }

    default:
      return { error: `Unknown tool: ${toolName}` };
  }
}


function buildMcpServer(db: Database.Database, workspacePath: string): McpServer {
  const server = new McpServer({ name: "cairn", version: "1.0.0" });

  // Register all tools from TOOL_SCHEMAS, excluding chat-only tools
  const chatOnlySet = new Set<string>(CHAT_ONLY_TOOLS);
  for (const [name, { description, schema }] of Object.entries(TOOL_SCHEMAS)) {
    if (chatOnlySet.has(name)) continue;
    server.tool(name, description, schema.shape as Record<string, z.ZodTypeAny>,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async (args: Record<string, any>) => {
        const result = executeTool(db, workspacePath, name, args);
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
  // PRAGMA foreign_keys must be set per-connection; applySchema is not called in the MCP process.
  db.pragma("foreign_keys = ON");
  db.pragma("journal_mode = WAL");
  ensureMcpActiveWritesTable(db);
  const workspacePath = findWorkspacePath(dbPath);
  process.stderr.write(`[cairn:mcp] Workspace folder: ${workspacePath}\n`);
  const server = buildMcpServer(db, workspacePath);
  const transport = new StdioServerTransport();
  server.connect(transport).catch((err) => {
    process.stderr.write(`[cairn:mcp] Fatal: ${err}\n`);
    process.exit(1);
  });
}
