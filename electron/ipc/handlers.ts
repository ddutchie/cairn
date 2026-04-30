/**
 * Cairn — IPC handlers
 *
 * Registered in main.ts via ipcMain.handle(channel, handler).
 * Each handler receives validated args from the renderer and
 * delegates to the SQLite query layer.
 *
 * All handlers return IpcResult<T> = { data: T } | { error: string }.
 * The renderer's ipcAwait helper should check for { error } and surface it.
 *
 * Note handlers additionally write/delete .md files in the workspace folder
 * so the file system stays in sync with SQLite.
 *
 * Channel naming: "db:<entity>:<action>"
 */

import { ipcMain, app, shell, dialog, BrowserWindow } from "electron";
import path from "path";
import fs from "fs";
import type Database from "better-sqlite3";
import * as q from "../db/queries";
import { registerChatHandler } from "./chat";
import { writeNoteFile, deleteNoteFile, deleteProjectNotesDir, stripMarkdown, findNoteFilePath } from "../notes-files";
import { buildContextResponse } from "../lib/context";
import { generatePrd } from "../lib/prd";
import { isLocalEndpoint } from "../lib/llm";
import { executeReadTool } from "../lib/read-tools";
import { readWorkspaceConfig, writeWorkspaceConfig } from "../workspace-config";
import { markMcpNotificationsRead } from "../db/queries";
import { DEFAULT_COLUMNS } from "../db/defaults";

// ── Result helpers ────────────────────────────────────────────────────────────

function ok<T>(data: T): { data: T } {
  return { data };
}

function err(message: string): { error: string } {
  return { error: message };
}

/**
 * Wrap a synchronous or async handler body in try/catch.
 * Returns { data } on success, { error } on failure.
 */
function handle<T>(fn: () => T | Promise<T>): Promise<{ data: T } | { error: string }> {
  return Promise.resolve()
    .then(() => fn())
    .then(ok)
    .catch((e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[cairn:ipc:error]", msg);
      return err(msg);
    });
}

function getProjectName(db: Database.Database, projectId: string): string {
  const row = db.prepare("SELECT name FROM projects WHERE id = ?").get(projectId) as { name: string } | undefined;
  return row?.name ?? projectId;
}

export function registerIpcHandlers(db: Database.Database, workspacePath: string): void {

  // ── Full snapshot (hydrate store on app launch) ───
  ipcMain.handle("db:snapshot", () => handle(() => q.getFullSnapshot(db)));
  ipcMain.handle("db:hasData",  () => handle(() => q.hasData(db)));

  // ── Dashboard live query bridge ───────────────────
  // Executes read-only MCP-style tool calls from dashboard iframes.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ipcMain.handle("db:mcpQuery", (_e, { tool, args }: { tool: string; args: Record<string, any> }) => {
    return handle(() => {
      if (tool === "get_cairn_context") {
        return buildContextResponse(db);
      }
      const snap = q.getFullSnapshot(db);
      const res = executeReadTool(db, snap, tool, args);
      if (res.handled) return res.result;
      throw new Error(`Unknown or disallowed tool: ${tool}`);
    });
  });

  // ── Workspaces ────────────────────────────────────
  ipcMain.handle("db:workspace:list",   () => handle(() => q.getAllWorkspaces(db)));
  ipcMain.handle("db:workspace:create", (_e, args) => handle(() => q.createWorkspace(db, args)));
  ipcMain.handle("db:workspace:update", (_e, { id, patch }) => handle(() => q.updateWorkspace(db, id, patch)));

  // ── Projects ──────────────────────────────────────
  ipcMain.handle("db:project:list",   (_e, { workspaceId }) => handle(() => q.getProjects(db, workspaceId)));
  ipcMain.handle("db:project:create", (_e, args) => handle(() => {
    const project = q.createProject(db, args);
    // Create default columns atomically in the same handler call
    if (args.withDefaultColumns) {
      const columns = DEFAULT_COLUMNS.map((col) =>
        q.createColumn(db, {
          id: q.generateId(),
          projectId: project.id,
          workspaceId: project.workspaceId,
          name: col.name,
          type: col.type,
          order: col.order,
        })
      );
      return { project, columns };
    }
    return { project, columns: [] };
  }));
  ipcMain.handle("db:project:update", (_e, { id, patch }) => handle(() => q.updateProject(db, id, patch)));
  ipcMain.handle("db:project:delete", (_e, { id }) => handle(() => {
    const project = q.getProjectById(db, id);
    if (project) {
      deleteProjectNotesDir(workspacePath, project.name);
    }
    q.deleteProject(db, id);
  }));

  // ── Notes ─────────────────────────────────────────
  // All note mutations also write/update/delete the corresponding .md file.

  ipcMain.handle("db:note:list", (_e, { projectId }) => handle(() => q.getNotes(db, projectId)));

  ipcMain.handle("db:note:create", (_e, args) => handle(() => {
    const note = q.createNote(db, {
      ...args,
      contentText: stripMarkdown(args.content ?? ""),
    });
    if (note.type !== "dashboard") {
      writeNoteFile(workspacePath, {
        ...note,
        projectName: getProjectName(db, note.projectId),
      });
    }
    return note;
  }));

  ipcMain.handle("db:note:update", (_e, { id, patch }) => handle(() => {
    // archivedAt: null means "restore" — COALESCE cannot clear to NULL
    if ("archivedAt" in patch && patch.archivedAt === null) {
      const rest = { ...patch };
      delete rest.archivedAt;
      if (Object.keys(rest).length > 0) {
        const enrichedRest = { ...rest };
        if (rest.content !== undefined && rest.contentText === undefined) {
          enrichedRest.contentText = stripMarkdown(rest.content);
        }
        q.updateNote(db, id, enrichedRest);
      }
      const note = q.restoreNote(db, id);
      if (note.type !== "dashboard") {
        writeNoteFile(workspacePath, { ...note, projectName: getProjectName(db, note.projectId) });
      }
      return note;
    }
    const enrichedPatch = { ...patch };
    if (patch.content !== undefined && patch.contentText === undefined) {
      enrichedPatch.contentText = stripMarkdown(patch.content);
    }
    const note = q.updateNote(db, id, enrichedPatch);
    if (note.type !== "dashboard") {
      writeNoteFile(workspacePath, {
        ...note,
        projectName: getProjectName(db, note.projectId),
      });
    }
    return note;
  }));

  ipcMain.handle("db:note:delete", (_e, { id }) => handle(() => {
    const note = q.getNoteById(db, id);
    if (note) {
      const projectName = getProjectName(db, note.projectId);
      q.deleteNote(db, id);
      if (note.type !== "dashboard") {
        deleteNoteFile(workspacePath, projectName, id);
      }
    } else {
      q.deleteNote(db, id);
    }
  }));

  // ── Reveal in Finder / Explorer ───────────────────
  ipcMain.handle("app:revealNote", (_e, { noteId, projectId }) => handle(() => {
    const projectName = getProjectName(db, projectId);
    const fp = findNoteFilePath(workspacePath, projectName, noteId);
    if (fp) {
      shell.showItemInFolder(fp);
    }
  }));

  // ── Board columns ─────────────────────────────────
  ipcMain.handle("db:column:list",   (_e, { projectId }) => handle(() => q.getColumns(db, projectId)));
  ipcMain.handle("db:column:create", (_e, args) => handle(() => q.createColumn(db, args)));
  ipcMain.handle("db:column:update", (_e, { id, patch }) => handle(() => q.updateColumn(db, id, patch)));
  ipcMain.handle("db:column:delete", (_e, { id }) => handle(() => q.deleteColumn(db, id)));

  // ── Task cards ────────────────────────────────────
  ipcMain.handle("db:card:list",   (_e, opts) => handle(() => q.getCards(db, opts)));
  ipcMain.handle("db:card:create", (_e, args) => handle(() => q.createCard(db, args)));
  ipcMain.handle("db:card:update", (_e, { id, patch }) => handle(() => {
    // archivedAt: null means "restore" — COALESCE cannot clear to NULL
    if ("archivedAt" in patch && patch.archivedAt === null) {
      const rest = { ...patch };
      delete rest.archivedAt;
      if (Object.keys(rest).length > 0) q.updateCard(db, id, rest);
      return q.restoreCard(db, id);
    }
    // dueDate: null means "clear due date"
    if ("dueDate" in patch && patch.dueDate === null) {
      const rest = { ...patch };
      delete rest.dueDate;
      if (Object.keys(rest).length > 0) q.updateCard(db, id, rest);
      return q.clearCardDueDate(db, id);
    }
    return q.updateCard(db, id, patch);
  }));
  ipcMain.handle("db:card:delete", (_e, { id }) => handle(() => q.deleteCard(db, id)));

  // ── Tags ──────────────────────────────────────────
  ipcMain.handle("db:tag:list",   (_e, { workspaceId }) => handle(() => q.getTags(db, workspaceId)));
  ipcMain.handle("db:tag:create", (_e, args) => handle(() => q.createTag(db, args)));
  ipcMain.handle("db:tag:update", (_e, { id, patch }) => handle(() => q.updateTag(db, id, patch)));
  ipcMain.handle("db:tag:delete", (_e, { id }) => handle(() => q.deleteTag(db, id)));

  // ── Chat ──────────────────────────────────────────
  ipcMain.handle("db:chat:threads",    (_e, { workspaceId }) => handle(() => q.getChatThreads(db, workspaceId)));
  ipcMain.handle("db:chat:messages",   (_e, { threadId }) => handle(() => q.getChatMessages(db, threadId)));
  ipcMain.handle("db:chat:upsertThread",  (_e, args) => handle(() => q.upsertChatThread(db, args)));
  ipcMain.handle("db:chat:addMessage",    (_e, args) => handle(() => q.addChatMessage(db, args)));
  ipcMain.handle("db:chat:deleteThread",  (_e, { threadId }) => handle(() => q.deleteChatThread(db, threadId)));

  // ── AI Chat completions ────────────────────────────
  registerChatHandler(db, workspacePath);

  // ── AI PRD generation (direct, no chat loop) ──────
  ipcMain.handle("ai:generatePrd", async (_e, args: {
    projectId: string;
    title: string;
    requirements: string;
    config: { baseUrl: string; model: string; apiKey: string };
  }) => {
    // PRD returns its own { error } shape for user-facing validation errors
    const baseUrl = (args.config.baseUrl || "https://api.openai.com").replace(/\/$/, "");
    const model = args.config.model || "gpt-4o-mini";
    const apiKey = args.config.apiKey || "";
    const isLocal = isLocalEndpoint(baseUrl);
    if (!apiKey && !isLocal) {
      return err("AI is not configured. Add an API key in Settings → AI & Chat, or use a local endpoint.");
    }
    const llmConfig = { baseUrl, model, apiKey };
    return handle(() => generatePrd(db, workspacePath, {
      projectId: args.projectId,
      title: args.title,
      requirements: args.requirements,
    }, llmConfig));
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
  win?: BrowserWindow,
): void {
  // ── Workspace folder selection / setup ────────────
  ipcMain.handle("app:selectWorkspaceFolder", async () => {
    return handle(async () => {
      const result = await dialog.showOpenDialog({
        // title renders on all platforms; message is macOS-only and silently ignored on Windows
        title: "Select a folder where Cairn will store your notes and database.",
        buttonLabel: "Use This Folder",
        properties: ["openDirectory", "createDirectory"],
      });
      if (result.canceled || result.filePaths.length === 0) return null;
      const chosen = result.filePaths[0];
      writeWorkspaceConfig(userDataPath, chosen);
      return chosen;
    });
  });

  ipcMain.handle("app:getWorkspacePath", () => handle(() =>
    readWorkspaceConfig(userDataPath)?.workspacePath ?? null
  ));

  ipcMain.handle("app:needsWorkspaceSetup", () => handle(() =>
    readWorkspaceConfig(userDataPath) === null
  ));

  ipcMain.handle("app:setTheme", (_e, theme: string) => handle(() => {
    const themeFile = path.join(userDataPath, "theme.json");
    fs.writeFileSync(themeFile, JSON.stringify({ theme }), "utf8");
    // On Windows, update the native title bar overlay to match the new theme.
    // Use --surface values (not backgroundColor) to match TitleBar's bg-[var(--surface)].
    // height:39 not 40 — Windows 1px window border makes 40 clip the border-b below the bar.
    if (process.platform === "win32" && win && !win.isDestroyed()) {
      const surface = theme === "light" ? "#ffffff" : "#141414";
      win.setTitleBarOverlay({ color: surface, symbolColor: "#888888", height: 39 });
    }
  }));

  ipcMain.handle("app:initWorkspace", (_e, { workspacePath: newPath }: { workspacePath: string }) => handle(() => {
    writeWorkspaceConfig(userDataPath, newPath);
    fs.mkdirSync(newPath, { recursive: true });
    // The DB was opened against the fallback path at startup — a relaunch is
    // required so main.ts re-reads the config and opens the correct cairn.db.
    return { requiresRestart: true };
  }));

  // ── App paths (for MCP config generation) ─────────
  ipcMain.handle("app:mcpServerPath", () => handle(() => {
    const appPath = app.getAppPath();
    const unpackedPath = appPath.replace(/\.asar$/, ".asar.unpacked");
    const binaryName = process.platform === "win32" ? "cairn-mcp.exe"
      : process.platform === "linux" ? "cairn-mcp-linux"
      : "cairn-mcp";
    return path.join(unpackedPath, "dist-mcp", binaryName);
  }));

  // ── Latest changelog ───────────────────────────────
  ipcMain.handle("app:latestChangelog", () => handle(() => {
    // In dev, app.getAppPath() points to dist-electron/ — walk up to repo root instead.
    // In packaged builds, changelogs/ is bundled inside the asar alongside dist-electron/.
    const changelogsDir = app.isPackaged
      ? path.join(app.getAppPath(), "changelogs")
      : path.join(__dirname, "..", "changelogs");
    if (!fs.existsSync(changelogsDir)) return null;
    const files = fs.readdirSync(changelogsDir)
      .filter((f) => /^v\d+\.\d+\.\d+\.md$/.test(f));
    if (files.length === 0) return null;
    // Sort by semver descending and pick the highest
    files.sort((a, b) => {
      const parse = (f: string) => f.replace(/^v/, "").replace(/\.md$/, "").split(".").map(Number);
      const [aMaj, aMin, aPatch] = parse(a);
      const [bMaj, bMin, bPatch] = parse(b);
      return bMaj - aMaj || bMin - aMin || bPatch - aPatch;
    });
    return fs.readFileSync(path.join(changelogsDir, files[0]), "utf8");
  }));

  // ── Relaunch (used after workspace init to re-open DB at correct path) ──
  ipcMain.handle("app:relaunch", () => handle(() => {
    app.relaunch();
    app.quit();
  }));

  // ── Auto-updater install ───────────────────────────
  ipcMain.handle("updater:install", () => handle(() => {
    // Dynamically import to avoid issues in dev where autoUpdater isn't active
    const { autoUpdater } = require("electron-updater");
    autoUpdater.quitAndInstall();
  }));

  // ── MCP notification handler ───────────────────────
  ipcMain.handle("mcp:markNotificationsRead", () => handle(() => {
    markMcpNotificationsRead(db);
    updateTrayBadge(0);
  }));
}
