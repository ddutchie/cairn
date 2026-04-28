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

import { ipcMain, app } from "electron";
import path from "path";
import type Database from "better-sqlite3";
import * as q from "../db/queries";
import { registerChatHandler } from "./chat";
import { writeNoteFile, deleteNoteFile, stripMarkdown } from "../notes-files";

function getProjectName(db: Database.Database, projectId: string): string {
  const row = db.prepare("SELECT name FROM projects WHERE id = ?").get(projectId) as { name: string } | undefined;
  return row?.name ?? projectId;
}

export function registerIpcHandlers(db: Database.Database, workspacePath: string): void {

  // ── Full snapshot (hydrate store on app launch) ───
  ipcMain.handle("db:snapshot", () => q.getFullSnapshot(db));
  ipcMain.handle("db:hasData",  () => q.hasData(db));

  // ── App paths (for MCP config generation) ────────
  ipcMain.handle("app:mcpServerPath", () => {
    const appPath = app.getAppPath();
    const unpackedPath = appPath.replace(/\.asar$/, ".asar.unpacked");
    return path.join(unpackedPath, "dist-mcp", "mcp-server.bundle.js");
  });

  // ── Workspaces ────────────────────────────────────
  ipcMain.handle("db:workspace:list",   () => q.getAllWorkspaces(db));
  ipcMain.handle("db:workspace:create", (_e, args) => q.createWorkspace(db, args));
  ipcMain.handle("db:workspace:update", (_e, { id, patch }) => q.updateWorkspace(db, id, patch));

  // ── Projects ──────────────────────────────────────
  ipcMain.handle("db:project:list",   (_e, { workspaceId }) => q.getProjects(db, workspaceId));
  ipcMain.handle("db:project:create", (_e, args) => q.createProject(db, args));
  ipcMain.handle("db:project:update", (_e, { id, patch }) => q.updateProject(db, id, patch));

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

  // ── Board columns ─────────────────────────────────
  ipcMain.handle("db:column:list",   (_e, { projectId }) => q.getColumns(db, projectId));
  ipcMain.handle("db:column:create", (_e, args) => q.createColumn(db, args));
  ipcMain.handle("db:column:update", (_e, { id, patch }) => q.updateColumn(db, id, patch));

  // ── Task cards ────────────────────────────────────
  ipcMain.handle("db:card:list",   (_e, opts) => q.getCards(db, opts));
  ipcMain.handle("db:card:create", (_e, args) => q.createCard(db, args));
  ipcMain.handle("db:card:update", (_e, { id, patch }) => q.updateCard(db, id, patch));
  ipcMain.handle("db:card:delete", (_e, { id }) => q.deleteCard(db, id));

  // ── Tags ──────────────────────────────────────────
  ipcMain.handle("db:tag:list",   (_e, { workspaceId }) => q.getTags(db, workspaceId));
  ipcMain.handle("db:tag:create", (_e, args) => q.createTag(db, args));

  // ── Chat ──────────────────────────────────────────
  ipcMain.handle("db:chat:threads",    (_e, { workspaceId }) => q.getChatThreads(db, workspaceId));
  ipcMain.handle("db:chat:messages",   (_e, { threadId }) => q.getChatMessages(db, threadId));
  ipcMain.handle("db:chat:upsertThread", (_e, args) => q.upsertChatThread(db, args));
  ipcMain.handle("db:chat:addMessage",   (_e, args) => q.addChatMessage(db, args));

  // ── AI Chat completions ────────────────────────────
  registerChatHandler(db, workspacePath);
}
