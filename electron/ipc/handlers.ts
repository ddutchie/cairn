/**
 * Cairn — IPC handlers
 *
 * Registered in main.ts via ipcMain.handle(channel, handler).
 * Each handler receives validated args from the renderer and
 * delegates to the SQLite query layer.
 *
 * Channel naming: "db:<entity>:<action>"
 */

import { ipcMain, app } from "electron";
import path from "path";
import type Database from "better-sqlite3";
import * as q from "../db/queries";
import { registerChatHandler } from "./chat";

export function registerIpcHandlers(db: Database.Database): void {

  // ── Full snapshot (hydrate store on app launch) ───
  ipcMain.handle("db:snapshot", () => q.getFullSnapshot(db));
  ipcMain.handle("db:hasData",  () => q.hasData(db));

  // ── App paths (for MCP config generation) ────────
  ipcMain.handle("app:mcpServerPath", () => {
    // In dev: app.asar doesn't exist — appPath is the project root, dist-mcp is right there.
    // In prod: dist-mcp is asarUnpacked, so it lives in app.asar.unpacked/, not app.asar/.
    const appPath = app.getAppPath(); // e.g. /.../Cairn.app/Contents/Resources/app.asar
    const unpackedPath = appPath.replace(/\.asar$/, ".asar.unpacked");
    // In dev appPath has no .asar suffix, so unpackedPath === appPath — works either way.
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
  ipcMain.handle("db:note:list",   (_e, { projectId }) => q.getNotes(db, projectId));
  ipcMain.handle("db:note:create", (_e, args) => q.createNote(db, args));
  ipcMain.handle("db:note:update", (_e, { id, patch }) => q.updateNote(db, id, patch));
  ipcMain.handle("db:note:delete", (_e, { id }) => q.deleteNote(db, id));

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
  registerChatHandler(db);
}
