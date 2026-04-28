/**
 * Cairn — Electron main process
 *
 * Responsibilities:
 * - Create the BrowserWindow
 * - Resolve the workspace folder (prompt user if first launch)
 * - Initialise SQLite at <workspacePath>/cairn.db
 * - Register all IPC handlers
 * - Start the file watcher for external .md edits
 * - In dev: load from Next.js dev server (localhost:3000)
 * - In prod: load from the exported static files
 */

import { app, BrowserWindow, shell, session, protocol, net, dialog, ipcMain } from "electron";
import path from "path";
import fs from "fs";
import { pathToFileURL } from "url";
import { initDb } from "./db/client";
import { registerIpcHandlers } from "./ipc/handlers";
import {
  readWorkspaceConfig,
  writeWorkspaceConfig,
  getDbPathForWorkspace,
} from "./workspace-config";
import { startFileWatcher } from "./file-watcher";

const isDev = !app.isPackaged;

app.setName("Cairn");

protocol.registerSchemesAsPrivileged([
  {
    scheme: "app",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: false,
    },
  },
]);

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: "hiddenInset",
    backgroundColor: "#0f0f0f",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  if (isDev) {
    win.loadURL("http://localhost:3000");
    win.webContents.openDevTools({ mode: "detach" });
  } else {
    win.loadURL("app://./index.html");
  }

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  return win;
}

async function promptWorkspaceFolder(): Promise<string | null> {
  const result = await dialog.showOpenDialog({
    title: "Choose your Cairn workspace folder",
    message: "Select a folder where Cairn will store your notes and database.",
    buttonLabel: "Use This Folder",
    properties: ["openDirectory", "createDirectory"],
  });

  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
}

app.whenReady().then(async () => {
  if (!isDev) {
    const outDir = path.join(__dirname, "../out");
    session.defaultSession.protocol.handle("app", (request) => {
      const url = new URL(request.url);
      let filePath = url.pathname.replace(/^\/\.\//, "").replace(/^\//, "");
      if (!filePath || filePath === "") filePath = "index.html";
      const fullPath = path.join(outDir, filePath);
      return net.fetch(pathToFileURL(fullPath).href);
    });
  }

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const csp = isDev
      ? [
          "default-src 'self' http://localhost:* ws://localhost:*",
          "script-src 'self' 'unsafe-inline' 'unsafe-eval' http://localhost:*",
          "style-src 'self' 'unsafe-inline'",
          "style-src-elem 'self' 'unsafe-inline'",
          "img-src 'self' data: blob:",
          "font-src 'self' data: https://fonts.gstatic.com",
          "connect-src 'self' http://localhost:* ws://localhost:*",
          "worker-src blob: 'self'",
        ].join("; ")
      : [
          "default-src 'self' app:",
          "script-src 'self' 'unsafe-inline' app:",
          "style-src 'self' 'unsafe-inline' app:",
          "style-src-elem 'self' 'unsafe-inline' app:",
          "img-src 'self' data: blob: app:",
          "font-src 'self' data: app:",
          "connect-src 'self' app: http://localhost:* https:",
          "worker-src blob: 'self' app:",
        ].join("; ");

    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [csp],
      },
    });
  });

  const userDataPath = app.getPath("userData");

  // ── Workspace folder IPC ──────────────────────────────────────────────
  ipcMain.handle("app:selectWorkspaceFolder", async () => {
    const chosen = await promptWorkspaceFolder();
    if (!chosen) return null;
    writeWorkspaceConfig(userDataPath, chosen);
    return chosen;
  });

  ipcMain.handle("app:getWorkspacePath", () => {
    return readWorkspaceConfig(userDataPath)?.workspacePath ?? null;
  });

  ipcMain.handle("app:needsWorkspaceSetup", () => {
    return readWorkspaceConfig(userDataPath) === null;
  });

  // Write config and create the folder; no migration needed for new users.
  ipcMain.handle("app:initWorkspace", (_e, { workspacePath: newPath }: { workspacePath: string }) => {
    writeWorkspaceConfig(userDataPath, newPath);
    fs.mkdirSync(newPath, { recursive: true });
    return { requiresRestart: false };
  });

  // ── Resolve workspace path ────────────────────────────────────────────
  const config = readWorkspaceConfig(userDataPath);
  const workspacePath = config
    ? config.workspacePath
    : path.join(userDataPath, "cairn"); // fallback while onboarding

  if (config) fs.mkdirSync(workspacePath, { recursive: true });

  const dbPath = getDbPathForWorkspace(workspacePath);
  const db = initDb(dbPath);

  registerIpcHandlers(db, workspacePath);

  const win = createWindow();

  // ── File watcher for external .md edits ──────────────────────────────
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  function notifyDbChanged() {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      if (!win.isDestroyed()) win.webContents.send("db:changed");
    }, 300);
  }

  startFileWatcher(workspacePath, db, notifyDbChanged);

  // ── Poll DB mtime for external writes (MCP server) ───────────────────
  const walPath = dbPath + "-wal";
  let lastMtime = 0;

  function checkDbChanged() {
    try {
      const target = fs.existsSync(walPath) ? walPath : dbPath;
      const mtime = fs.statSync(target).mtimeMs;
      if (mtime > lastMtime) {
        lastMtime = mtime;
        notifyDbChanged();
      }
    } catch { /* db file not yet created */ }
  }

  try { lastMtime = fs.statSync(fs.existsSync(walPath) ? walPath : dbPath).mtimeMs; } catch { /* ok */ }

  setInterval(checkDbChanged, 1000);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
