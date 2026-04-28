/**
 * Cairn — Electron main process
 *
 * Responsibilities:
 * - Create the BrowserWindow
 * - Initialise SQLite at userData path
 * - Register all IPC handlers
 * - In dev: load from Next.js dev server (localhost:3000)
 * - In prod: load from the exported static files
 */

import { app, BrowserWindow, shell, session, protocol, net } from "electron";
import path from "path";
import fs from "fs";
import { pathToFileURL } from "url";
import { initDb } from "./db/client";
import { registerIpcHandlers } from "./ipc/handlers";

const isDev = !app.isPackaged;

// Set app name before anything else so userData goes to the right folder.
// Without this, dev builds use "Electron" as the userData directory name.
app.setName("Cairn");

// Register app:// as a privileged standard scheme so the renderer can load
// the Next.js static export as if it were served from a real origin.
// Must be called before app.whenReady().
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
    titleBarStyle: "hiddenInset",   // macOS native traffic lights
    backgroundColor: "#0f0f0f",    // match app background, avoids flash
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,       // keep renderer sandboxed
      sandbox: false,               // needed for preload to use require
    },
  });

  if (isDev) {
    win.loadURL("http://localhost:3000");
    win.webContents.openDevTools({ mode: "detach" });
  } else {
    win.loadURL("app://./index.html");
  }

  // Open external links in the system browser, not Electron
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  return win;
}

app.whenReady().then(() => {
  // Register app:// protocol to serve the Next.js static export from the asar.
  // Handles app://./index.html → out/index.html, app://./_next/... → out/_next/...
  if (!isDev) {
    const outDir = path.join(__dirname, "../out");
    session.defaultSession.protocol.handle("app", (request) => {
      const url = new URL(request.url);
      // Strip leading "./" or "/" from pathname
      let filePath = url.pathname.replace(/^\/\.\/|^\//, "");
      if (!filePath || filePath === "") filePath = "index.html";
      const fullPath = path.join(outDir, filePath);
      return net.fetch(pathToFileURL(fullPath).href);
    });
  }

  // Set Content-Security-Policy.
  // Dev: allow localhost + unsafe-eval for HMR.
  // Prod: app:// scheme is the origin — allow inline styles (Next.js needs it).
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

  // Initialise SQLite — creates the DB file in ~/Library/Application Support/cairn/
  const db = initDb(app.getPath("userData"));

  // Register all IPC channels before the window loads
  registerIpcHandlers(db);

  const win = createWindow();

  // Poll the DB mtime for external writes (e.g. MCP server).
  // fs.watch is unreliable on macOS for SQLite WAL-mode files written by
  // another process (writes go to -wal/-shm, not the main file directly).
  const dbPath = path.join(app.getPath("userData"), "cairn", "cairn.db");
  const walPath = dbPath + "-wal";
  let lastMtime = 0;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  function checkDbChanged() {
    try {
      // WAL mode: the -wal file mtime changes on every write from another process
      const target = fs.existsSync(walPath) ? walPath : dbPath;
      const mtime = fs.statSync(target).mtimeMs;
      if (mtime > lastMtime) {
        lastMtime = mtime;
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
  
          if (!win.isDestroyed()) win.webContents.send("db:changed");
        }, 300);
      }
    } catch { /* db file not yet created */ }
  }

  // Initialise lastMtime so we don't fire immediately on startup
  try { lastMtime = fs.statSync(fs.existsSync(walPath) ? walPath : dbPath).mtimeMs; } catch { /* ok */ }

  setInterval(checkDbChanged, 1000);

  app.on("activate", () => {
    // macOS: re-create window when dock icon is clicked and no windows open
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

});

app.on("window-all-closed", () => {
  // On macOS it's conventional to keep the app running until Cmd+Q
  if (process.platform !== "darwin") app.quit();
});
