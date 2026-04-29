/**
 * Cairn — IPC handlers
 *
 * Registered in main.ts via ipcMain.handle(channel, handler).
 * Each handler receives validated args from the renderer and
 * delegates to the SQLite query layer.
 *
 * Note handlers additionally write/delete .md files in the workspace folder
 * so the file system stays in sync with SQLite.
 *
 * Channel naming: "db:<entity>:<action>"
 */

import { ipcMain, app, shell, dialog } from "electron";
import path from "path";
import fs from "fs";
import type Database from "better-sqlite3";
import * as q from "../db/queries";
import { registerChatHandler } from "./chat";
import { writeNoteFile, deleteNoteFile, deleteProjectNotesDir, stripMarkdown, findNoteFilePath } from "../notes-files";
import { buildContextResponse } from "../lib/context";
import { generatePrd } from "../lib/prd";
import { newId, ts } from "../db/utils";
import { isLocalEndpoint } from "../lib/llm";
import { readWorkspaceConfig, writeWorkspaceConfig } from "../workspace-config";
import { markMcpNotificationsRead } from "../db/queries";

function getProjectName(db: Database.Database, projectId: string): string {
  const row = db.prepare("SELECT name FROM projects WHERE id = ?").get(projectId) as { name: string } | undefined;
  return row?.name ?? projectId;
}

export function registerIpcHandlers(db: Database.Database, workspacePath: string): void {

  // ── Full snapshot (hydrate store on app launch) ───
  ipcMain.handle("db:snapshot", () => q.getFullSnapshot(db));
  ipcMain.handle("db:hasData",  () => q.hasData(db));

  // ── Dashboard live query bridge ───────────────────
  // Executes read-only MCP-style tool calls from dashboard iframes.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ipcMain.handle("db:mcpQuery", (_e, { tool, args }: { tool: string; args: Record<string, any> }) => {
    const snap = q.getFullSnapshot(db);
    switch (tool) {
      case "get_cairn_context":
        return buildContextResponse(db);
      case "get_project_summary": {
        const project = snap.projects.find((p) => p.id === args.projectId);
        if (!project) return { error: "Project not found" };
        const cols = snap.columns.filter((c) => c.projectId === args.projectId).sort((a, b) => a.order - b.order);
        const columns = cols.map((col) => {
          const cards = snap.cards.filter((c) => c.columnId === col.id && !c.archivedAt);
          return { id: col.id, name: col.name, type: col.type, taskCount: cards.length,
            tasks: cards.map((c) => ({ id: c.id, title: c.title, priority: c.priority, dueDate: c.dueDate })) };
        });
        return {
          project: { id: project.id, name: project.name, status: project.status, priority: project.priority, dueDate: project.dueDate },
          noteCount: snap.notes.filter((n) => n.projectId === args.projectId && !n.archivedAt).length,
          totalCards: snap.cards.filter((c) => c.projectId === args.projectId && !c.archivedAt).length,
          columns,
        };
      }
      case "list_tasks": {
        const cols = snap.columns.filter((c) => !args.projectId || c.projectId === args.projectId);
        const tasksByColumn: Record<string, unknown[]> = {};
        cols.sort((a, b) => a.order - b.order).forEach((col) => {
          tasksByColumn[col.id] = snap.cards
            .filter((c) => c.columnId === col.id && !c.archivedAt)
            .map((c) => ({ id: c.id, title: c.title, priority: c.priority, description: c.description,
              dueDate: c.dueDate, columnId: col.id, columnName: col.name, columnType: col.type,
              updatedAt: c.updatedAt, archivedAt: c.archivedAt ?? null }));
        });
        return { tasksByColumn };
      }
      case "list_notes": {
        return snap.notes.filter((n) => !n.archivedAt && (!args.projectId || n.projectId === args.projectId))
          .map((n) => ({ id: n.id, title: n.title, projectId: n.projectId, isPinned: n.isPinned, updatedAt: n.updatedAt }));
      }
      case "list_recent_activity": {
        const limit = args.limit ?? 20;
        const recentNotes = snap.notes
          .filter((n) => !n.archivedAt && (!args.workspaceId || n.workspaceId === args.workspaceId) && (!args.projectId || n.projectId === args.projectId))
          .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
          .slice(0, limit)
          .map((n) => ({ id: n.id, title: n.title, projectId: n.projectId, updatedAt: n.updatedAt }));
        const recentTasks = snap.cards
          .filter((c) => !c.archivedAt && (!args.workspaceId || c.workspaceId === args.workspaceId) && (!args.projectId || c.projectId === args.projectId))
          .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
          .slice(0, limit)
          .map((c) => ({ id: c.id, title: c.title, projectId: c.projectId, updatedAt: c.updatedAt }));
        return { recentNotes, recentTasks };
      }
      case "search_tasks": {
        return q.searchTasks(db, { query: String(args.query), projectId: args.projectId as string | undefined, limit: args.limit as number | undefined })
          .map((c) => ({ id: c.id, title: c.title, priority: c.priority, columnId: c.columnId }));
      }
      case "search_notes": {
        return q.searchNotes(db, { query: String(args.query), projectId: args.projectId as string | undefined, limit: args.limit as number | undefined })
          .map((n) => ({ id: n.id, title: n.title, snippet: n.contentText.slice(0, 200), projectId: n.projectId }));
      }
      default:
        return { error: `Unknown or disallowed tool: ${tool}` };
    }
  });

  // ── Workspaces ────────────────────────────────────
  ipcMain.handle("db:workspace:list",   () => q.getAllWorkspaces(db));
  ipcMain.handle("db:workspace:create", (_e, args) => q.createWorkspace(db, args));
  ipcMain.handle("db:workspace:update", (_e, { id, patch }) => q.updateWorkspace(db, id, patch));

  // ── Projects ──────────────────────────────────────
  ipcMain.handle("db:project:list",   (_e, { workspaceId }) => q.getProjects(db, workspaceId));
  ipcMain.handle("db:project:create", (_e, args) => q.createProject(db, args));
  ipcMain.handle("db:project:update", (_e, { id, patch }) => q.updateProject(db, id, patch));
  ipcMain.handle("db:project:delete", (_e, { id }) => {
    // Delete .md files before wiping SQLite rows (we need the project name for folder lookup)
    const project = db.prepare("SELECT name FROM projects WHERE id = ?").get(id) as { name: string } | undefined;
    if (project) {
      deleteProjectNotesDir(workspacePath, project.name);
    }
    q.deleteProject(db, id);
  });

  // ── Notes ─────────────────────────────────────────
  // All note mutations also write/update/delete the corresponding .md file.

  ipcMain.handle("db:note:list", (_e, { projectId }) => q.getNotes(db, projectId));

  ipcMain.handle("db:note:create", (_e, args) => {
    const note = q.createNote(db, {
      ...args,
      contentText: stripMarkdown(args.content ?? ""),
    });
    writeNoteFile(workspacePath, {
      ...note,
      projectName: getProjectName(db, note.projectId),
    });
    return note;
  });

  ipcMain.handle("db:note:update", (_e, { id, patch }) => {
    const enrichedPatch = { ...patch };
    if (patch.content !== undefined && patch.contentText === undefined) {
      enrichedPatch.contentText = stripMarkdown(patch.content);
    }
    const note = q.updateNote(db, id, enrichedPatch);
    writeNoteFile(workspacePath, {
      ...note,
      projectName: getProjectName(db, note.projectId),
    });
    return note;
  });

  ipcMain.handle("db:note:delete", (_e, { id }) => {
    const row = db.prepare("SELECT project_id FROM notes WHERE id = ?").get(id) as { project_id: string } | undefined;
    if (row) {
      const projectName = getProjectName(db, row.project_id);
      q.deleteNote(db, id);
      deleteNoteFile(workspacePath, projectName, id);
    } else {
      q.deleteNote(db, id);
    }
  });

  // ── Reveal in Finder / Explorer ───────────────────
  ipcMain.handle("app:revealNote", (_e, { noteId, projectId }) => {
    const projectName = getProjectName(db, projectId);
    const fp = findNoteFilePath(workspacePath, projectName, noteId);
    if (fp) {
      shell.showItemInFolder(fp);
    }
  });

  // ── Board columns ─────────────────────────────────
  ipcMain.handle("db:column:list",   (_e, { projectId }) => q.getColumns(db, projectId));
  ipcMain.handle("db:column:create", (_e, args) => q.createColumn(db, args));
  ipcMain.handle("db:column:update", (_e, { id, patch }) => q.updateColumn(db, id, patch));
  ipcMain.handle("db:column:delete", (_e, { id }) => q.deleteColumn(db, id));

  // ── Task cards ────────────────────────────────────
  ipcMain.handle("db:card:list",   (_e, opts) => q.getCards(db, opts));
  ipcMain.handle("db:card:create", (_e, args) => q.createCard(db, args));
  ipcMain.handle("db:card:update", (_e, { id, patch }) => q.updateCard(db, id, patch));
  ipcMain.handle("db:card:delete", (_e, { id }) => q.deleteCard(db, id));

  // ── Tags ──────────────────────────────────────────
  ipcMain.handle("db:tag:list",   (_e, { workspaceId }) => q.getTags(db, workspaceId));
  ipcMain.handle("db:tag:create", (_e, args) => q.createTag(db, args));
  ipcMain.handle("db:tag:update", (_e, { id, patch }) => q.updateTag(db, id, patch));
  ipcMain.handle("db:tag:delete", (_e, { id }) => q.deleteTag(db, id));

  // ── Chat ──────────────────────────────────────────
  ipcMain.handle("db:chat:threads",    (_e, { workspaceId }) => q.getChatThreads(db, workspaceId));
  ipcMain.handle("db:chat:messages",   (_e, { threadId }) => q.getChatMessages(db, threadId));
  ipcMain.handle("db:chat:upsertThread",  (_e, args) => q.upsertChatThread(db, args));
  ipcMain.handle("db:chat:addMessage",    (_e, args) => q.addChatMessage(db, args));
  ipcMain.handle("db:chat:deleteThread",  (_e, { threadId }) => q.deleteChatThread(db, threadId));

  // ── AI Chat completions ────────────────────────────
  registerChatHandler(db, workspacePath);

  // ── AI PRD generation (direct, no chat loop) ──────
  ipcMain.handle("ai:generatePrd", async (_e, args: {
    projectId: string;
    title: string;
    requirements: string;
    config: { baseUrl: string; model: string; apiKey: string };
  }) => {
    const baseUrl = (args.config.baseUrl || "https://api.openai.com").replace(/\/$/, "");
    const model = args.config.model || "gpt-4o-mini";
    const apiKey = args.config.apiKey || "";
    const isLocal = baseUrl.includes("localhost") || baseUrl.includes("127.0.0.1") || baseUrl.includes("0.0.0.0");
    if (!apiKey && !isLocal) {
      return { error: "AI is not configured. Add an API key in Settings → AI & Chat, or use a local endpoint." };
    }
    const llmConfig = { baseUrl, model, apiKey };
    return generatePrd(db, workspacePath, {
      projectId: args.projectId,
      title: args.title,
      requirements: args.requirements,
    }, llmConfig);
  });
}

/**
 * Register app-level IPC handlers that were previously inlined in main.ts.
 *
 * @param db              - the SQLite database instance
 * @param userDataPath    - result of app.getPath("userData")
 * @param updateTrayBadge - callback to update the tray badge count
 */
export function registerAppHandlers(
  db: Database.Database,
  userDataPath: string,
  updateTrayBadge: (count: number) => void,
): void {
  // ── Workspace folder selection / setup ────────────
  ipcMain.handle("app:selectWorkspaceFolder", async () => {
    const result = await dialog.showOpenDialog({
      title: "Choose your Cairn workspace folder",
      message: "Select a folder where Cairn will store your notes and database.",
      buttonLabel: "Use This Folder",
      properties: ["openDirectory", "createDirectory"],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    const chosen = result.filePaths[0];
    writeWorkspaceConfig(userDataPath, chosen);
    return chosen;
  });

  ipcMain.handle("app:getWorkspacePath", () => {
    return readWorkspaceConfig(userDataPath)?.workspacePath ?? null;
  });

  ipcMain.handle("app:needsWorkspaceSetup", () => {
    return readWorkspaceConfig(userDataPath) === null;
  });

  // Persist theme choice so the main process can read it for backgroundColor
  ipcMain.handle("app:setTheme", (_e, theme: string) => {
    const themeFile = path.join(userDataPath, "theme.json");
    fs.writeFileSync(themeFile, JSON.stringify({ theme }), "utf8");
  });

  // Write config and create the folder; no migration needed for new users.
  ipcMain.handle("app:initWorkspace", (_e, { workspacePath: newPath }: { workspacePath: string }) => {
    writeWorkspaceConfig(userDataPath, newPath);
    fs.mkdirSync(newPath, { recursive: true });
    return { requiresRestart: false };
  });

  // ── App paths (for MCP config generation) ─────────
  ipcMain.handle("app:mcpServerPath", () => {
    const appPath = app.getAppPath();
    const unpackedPath = appPath.replace(/\.asar$/, ".asar.unpacked");
    const binaryName = process.platform === "win32" ? "cairn-mcp.exe"
      : process.platform === "linux" ? "cairn-mcp-linux"
      : "cairn-mcp";
    return path.join(unpackedPath, "dist-mcp", binaryName);
  });

  // ── MCP notification handler ───────────────────────
  ipcMain.handle("mcp:markNotificationsRead", () => {
    markMcpNotificationsRead(db);
    updateTrayBadge(0);
  });
}
