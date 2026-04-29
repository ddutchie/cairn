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

import { app, BrowserWindow, shell, session, protocol, net, dialog, ipcMain, Tray, Menu, Notification, nativeImage } from "electron";
import path from "path";
import fs from "fs";
import { pathToFileURL } from "url";
import { autoUpdater } from "electron-updater";
import { initDb } from "./db/client";
import { registerIpcHandlers } from "./ipc/handlers";
import {
  readWorkspaceConfig,
  writeWorkspaceConfig,
  getDbPathForWorkspace,
} from "./workspace-config";
import { startFileWatcher } from "./file-watcher";
import { getUnreadMcpNotifications, markMcpNotificationsRead } from "./db/queries";

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

function getStoredThemeBackground(): string {
  try {
    const userDataPath = app.getPath("userData");
    const lsPath = path.join(userDataPath, "Local Storage", "leveldb");
    // Can't easily read leveldb from main — use a simple fallback:
    // write theme to a plain JSON sidecar file whenever it changes (see IPC below)
    const themeFile = path.join(userDataPath, "theme.json");
    if (fs.existsSync(themeFile)) {
      const t = JSON.parse(fs.readFileSync(themeFile, "utf8")).theme;
      if (t === "light") return "#f5f4f1";
    }
  } catch { /* ignore */ }
  return "#0d0d0d";
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: "hiddenInset",
    backgroundColor: getStoredThemeBackground(),
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

  // ── Auto-updater ──────────────────────────────────────────────────────
  if (!isDev) {
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.on("update-available", (info) => {
      win.webContents.send("updater:update-available", {
        version: info.version,
        releaseNotes: info.releaseNotes ?? null,
      });
    });

    autoUpdater.on("update-downloaded", () => {
      win.webContents.send("updater:update-downloaded");
    });

    autoUpdater.on("error", (err) => {
      // Log silently — don't surface network errors to the user
      console.error("[updater]", err.message);
    });

    // IPC: renderer asks to install now and restart
    ipcMain.handle("updater:install", () => {
      autoUpdater.quitAndInstall();
    });

    // Check on launch, then every 4 hours
    autoUpdater.checkForUpdates().catch(() => {});
    setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 4 * 60 * 60 * 1000);
  }

  // ── File watcher for external .md edits ──────────────────────────────
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  function notifyDbChanged() {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      if (!win.isDestroyed()) win.webContents.send("db:changed");
    }, 300);
  }

  startFileWatcher(workspacePath, db, notifyDbChanged);

  // ── System tray ───────────────────────────────────────────────────────
  // On macOS: use trayTemplate.png (black + transparent, 22×22).
  // Electron auto-picks trayTemplate@2x.png on retina when loaded by base name.
  // On Windows/Linux: fall back to icon.png.
  const trayIconDir = isDev
    ? path.join(__dirname, "..", "public")
    : path.join(process.resourcesPath, "app.asar", "out");

  let trayImage: ReturnType<typeof nativeImage.createFromPath>;
  if (process.platform === "darwin") {
    const templatePath = path.join(trayIconDir, "trayTemplate.png");
    trayImage = nativeImage.createFromPath(templatePath);
    trayImage.setTemplateImage(true);
  } else {
    const iconPath = path.join(trayIconDir, "icon.png");
    trayImage = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
  }

  const tray = new Tray(trayImage);
  tray.setToolTip("Cairn");

  function buildTrayMenu(unreadCount: number) {
    return Menu.buildFromTemplate([
      {
        label: unreadCount > 0 ? `${unreadCount} unread MCP update${unreadCount > 1 ? "s" : ""}` : "No new MCP updates",
        enabled: false,
      },
      { type: "separator" },
      {
        label: "Open Cairn",
        click: () => {
          win.show();
          win.focus();
        },
      },
      { type: "separator" },
      { label: "Quit", click: () => app.quit() },
    ]);
  }

  tray.setContextMenu(buildTrayMenu(0));

  tray.on("click", () => {
    win.show();
    win.focus();
  });

  // ── MCP notification badge state ─────────────────────────────────────
  let unreadCount = 0;

  function updateTrayBadge(count: number) {
    unreadCount = count;
    tray.setContextMenu(buildTrayMenu(count));
    if (process.platform === "darwin") {
      app.setBadgeCount(count);
    }
    if (!win.isDestroyed()) {
      win.webContents.send("mcp:unread-count", count);
    }
  }

  // Clear badge when the window gains focus
  win.on("focus", () => {
    if (unreadCount > 0) {
      markMcpNotificationsRead(db);
      updateTrayBadge(0);
    }
  });

  // IPC: renderer can also request a clear (e.g. on first load)
  ipcMain.handle("mcp:markNotificationsRead", () => {
    markMcpNotificationsRead(db);
    updateTrayBadge(0);
  });

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

        // Check for new MCP notifications and fire OS toasts
        const unread = getUnreadMcpNotifications(db);
        for (const n of unread) {
          if (Notification.isSupported()) {
            new Notification({ title: n.title, body: n.body, silent: false }).show();
          }
        }
        if (unread.length > 0) {
          updateTrayBadge(unreadCount + unread.length);
          markMcpNotificationsRead(db);
        }
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
