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
import { syncNotesFromDisk } from "./notes-files";
import { markMcpNotificationsRead } from "./db/queries";
import { setupProtocol, registerAssetProtocol, setAssetWorkspacePath } from "./lib/protocol";
import { createTray } from "./lib/tray";
import { startMcpNotificationPoller } from "./lib/mcp-poller";

const isDev = !app.isPackaged;

app.setName("Cairn");

// Windows: required for Toast notifications to show with the correct app identity.
// Must be called before app.whenReady() and must match the appId in electron-builder.yml.
if (process.platform === "win32") {
  app.setAppUserModelId("com.cairn.app");
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: "app",
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: false },
  },
  {
    scheme: "asset",
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: false },
  },
]);

// Returns the window background colour for the stored theme.
// Used as BrowserWindow.backgroundColor (fills the window before React renders).
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

// Returns the --surface colour for the stored theme.
// Used as the titleBarOverlay colour on Windows so the native min/max/close
// buttons blend with the rendered TitleBar component (bg-[var(--surface)]).
// Must match the --surface values in globals.css exactly.
function getStoredThemeSurface(): string {
  try {
    const userDataPath = app.getPath("userData");
    const themeFile = path.join(userDataPath, "theme.json");
    if (fs.existsSync(themeFile)) {
      const t = JSON.parse(fs.readFileSync(themeFile, "utf8")).theme;
      if (t === "light") return "#ffffff";  // --surface in .light (globals.css:35)
    }
  } catch { /* ignore */ }
  return "#141414";  // --surface in .dark (globals.css:11)
}

function createWindow(): BrowserWindow {
  const isWin = process.platform === "win32";
  const bg = getStoredThemeBackground();
  const surface = getStoredThemeSurface();

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
        // Use --surface (not backgroundColor) so the overlay matches the
        // rendered TitleBar component which uses bg-[var(--surface)].
        color: surface,
        symbolColor: "#888888",
        // 39px not 40px: Windows adds a 1px window border at the top, so
        // height:40 overshoots by 1px and clips the border-b beneath the bar.
        height: 39,
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
  const initialWorkspacePath = config
    ? config.workspacePath
    : path.join(userDataPath, "cairn"); // fallback while onboarding

  if (config) fs.mkdirSync(initialWorkspacePath, { recursive: true });

  // Register the asset:// protocol handler once. The workspace path it reads
  // is updated via setAssetWorkspacePath() — no re-registration needed.
  registerAssetProtocol();
  setAssetWorkspacePath(initialWorkspacePath);

  const initialDbPath = getDbPathForWorkspace(initialWorkspacePath);
  const initialDb = initDb(initialDbPath);

  // Recover any notes written to disk but missing from SQLite (e.g. due to
  // a fire-and-forget IPC race or unexpected shutdown).
  syncNotesFromDisk(initialDb, initialWorkspacePath);

  // ── Mutable context — swapped in reinitialise() without relaunching ──
  const ctx: import("./ipc/handlers").DbContext = {
    db: initialDb,
    workspacePath: initialWorkspacePath,
  };

  registerIpcHandlers(ctx);

  const win = createWindow();

  // ── File watcher for external .md edits ──────────────────────────────
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  function notifyDbChanged() {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      if (!win.isDestroyed()) win.webContents.send("db:changed");
    }, 300);
  }

  startFileWatcher(initialWorkspacePath, initialDb, notifyDbChanged);

  // ── Reinitialise without relaunching ─────────────────────────────────
  // Called by app:initWorkspace when the user picks a workspace folder for
  // the first time. Swaps the DB and file watcher in place so the onboarding
  // wizard can continue without a full app restart.
  async function reinitialise(newWorkspacePath: string): Promise<void> {
    fs.mkdirSync(newWorkspacePath, { recursive: true });

    // Open the new DB
    const newDbPath = getDbPathForWorkspace(newWorkspacePath);
    const newDb = initDb(newDbPath);

    // Recover any notes on disk not yet in SQLite before swapping context
    syncNotesFromDisk(newDb, newWorkspacePath);

    // Swap context — all handlers read from ctx at call time
    ctx.db = newDb;
    ctx.workspacePath = newWorkspacePath;

    // Restart file watcher on the new path
    startFileWatcher(newWorkspacePath, newDb, notifyDbChanged);

    // Point the asset:// handler at the new workspace (no re-registration needed)
    setAssetWorkspacePath(newWorkspacePath);

    // Tell the renderer to re-hydrate from the new DB
    if (!win.isDestroyed()) {
      win.webContents.send("db:changed");
    }
  }

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

  // ── System tray ───────────────────────────────────────────────────────
  const { updateBadge } = createTray(win);

  // Clear badge when window gains focus
  let unreadCount = 0;
  win.on("focus", () => {
    if (unreadCount > 0) {
      markMcpNotificationsRead(ctx.db);
      updateBadge(0);
      unreadCount = 0;
    }
  });

  // Register app:* and mcp:* IPC handlers (now that updateBadge is available)
  registerAppHandlers(ctx.db, userDataPath, updateBadge, win, reinitialise);

  // ── MCP notification poller ───────────────────────────────────────────
  startMcpNotificationPoller({
    db: ctx.db,
    dbPath: initialDbPath,
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
