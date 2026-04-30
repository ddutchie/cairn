/**
 * Cairn — Electron main process
 *
 * Orchestrates startup:
 * 1. Register the app:// protocol + CSP
 * 2. Resolve workspace folder
 * 3. Initialise SQLite
 * 4. Register IPC handlers
 * 5. Create BrowserWindow
 * 6. Set up auto-updater (prod only)
 * 7. Start file watcher for external .md edits
 * 8. Create system tray
 * 9. Start MCP notification poller
 */

import { app, BrowserWindow, shell, protocol } from "electron";
import path from "path";
import fs from "fs";
import { autoUpdater } from "electron-updater";
import { initDb } from "./db/client";
import { registerIpcHandlers, registerAppHandlers } from "./ipc/handlers";
import { readWorkspaceConfig, getDbPathForWorkspace } from "./workspace-config";
import { startFileWatcher } from "./file-watcher";
import { markMcpNotificationsRead } from "./db/queries";
import { setupProtocol } from "./lib/protocol";
import { createTray } from "./lib/tray";
import { startMcpNotificationPoller } from "./lib/mcp-poller";

const isDev = !app.isPackaged;

app.setName("Cairn");

protocol.registerSchemesAsPrivileged([
  {
    scheme: "app",
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: false },
  },
]);

function getStoredThemeBackground(): string {
  try {
    const userDataPath = app.getPath("userData");
    const themeFile = path.join(userDataPath, "theme.json");
    if (fs.existsSync(themeFile)) {
      const t = JSON.parse(fs.readFileSync(themeFile, "utf8")).theme;
      if (t === "light") return "#f5f4f1";
    }
  } catch { /* ignore */ }
  return "#0d0d0d";
}

function createWindow(): BrowserWindow {
  const isWin = process.platform === "win32";
  const bg = getStoredThemeBackground();

  // On macOS: hiddenInset keeps the traffic lights in the title bar area.
  // On Windows: hidden removes the native title text; titleBarOverlay places
  // the native min/max/close buttons at the top-right inside our custom bar.
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: isWin ? "hidden" : "hiddenInset",
    ...(isWin && {
      titleBarOverlay: {
        color: bg,          // matches window background so buttons blend in
        symbolColor: "#888888",
        height: 40,         // matches TitleBar height in the renderer
      },
    }),
    backgroundColor: bg,
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

app.whenReady().then(async () => {
  const outDir = path.join(__dirname, "../out");
  setupProtocol(outDir);

  const userDataPath = app.getPath("userData");

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

  // ── Auto-updater (prod only) ──────────────────────────────────────────
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
      console.error("[updater]", err.message);
    });

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
  const { updateBadge } = createTray(win);

  // Clear badge when window gains focus
  let unreadCount = 0;
  win.on("focus", () => {
    if (unreadCount > 0) {
      markMcpNotificationsRead(db);
      updateBadge(0);
      unreadCount = 0;
    }
  });

  // Register app:* and mcp:* IPC handlers (now that updateBadge is available)
  registerAppHandlers(db, userDataPath, updateBadge, win);

  // ── MCP notification poller ───────────────────────────────────────────
  startMcpNotificationPoller({
    db,
    dbPath,
    win,
    updateBadge: (count) => {
      unreadCount = count;
      updateBadge(count);
    },
    onDbChanged: notifyDbChanged,
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
