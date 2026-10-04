/** The main app window: creation, dev/prod loading and navigation lockdown. */

import { BrowserWindow, shell } from "electron";
import path from "path";
import { readThemeSurface } from "./lib/theme-surface";

/** Windows built by createWindow — the only ones the tray and Quick Capture may target. */
const mainWindows = new WeakSet<BrowserWindow>();

export function isMainWindow(win: BrowserWindow): boolean {
  return mainWindows.has(win);
}

export function createWindow(isDev: boolean): BrowserWindow {
  const isWin = process.platform === "win32";
  const { surface, bg } = readThemeSurface();

  // On macOS: hiddenInset keeps the traffic lights in the title bar area.
  // On Windows: hidden removes the native title text; titleBarOverlay places
  // the native min/max/close buttons at the top-right inside our custom bar.
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    show: false,
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
      // H7: sandbox:false widens the renderer blast radius (no OS-level sandbox).
      // TODO: roadmap to sandbox:true — requires auditing preload exposure and
      // moving sqlite/native work to a utilityProcess. Tracked separately; don't
      // flip this flag without that hardening.
      sandbox: false,
    },
  });
  mainWindows.add(win);

  if (isDev) {
    win.loadURL("http://localhost:3000");
    // Keep DevTools closed in headless/recording runs (CAIRN_NO_DEVTOOLS=1, used
    // by the demo/QA harness) so the detached inspector window doesn't steal the
    // Playwright video recording or pop a second window during capture.
    if (process.env.CAIRN_NO_DEVTOOLS !== "1") {
      win.webContents.openDevTools({ mode: "detach" });
    }
  } else {
    win.loadURL("app://./index.html");
  }

  win.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === "https:" || parsed.protocol === "http:" || parsed.protocol === "mailto:") {
        shell.openExternal(url);
      }
    } catch { /* malformed URL — deny */ }
    return { action: "deny" };
  });

  // Deny any in-page navigation to external origins. Only allow the bundled
  // app:// scheme, the asset:// scheme, and the localhost dev server.
  win.webContents.on("will-navigate", (event, url) => {
    try {
      const parsed = new URL(url);
      const allowed =
        parsed.protocol === "app:" ||
        parsed.protocol === "asset:" ||
        (parsed.protocol === "http:" && (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1")) ||
        (parsed.protocol === "ws:" && (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1")) ||
        (parsed.protocol === "https:" && (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1"));
      if (!allowed) event.preventDefault();
    } catch {
      event.preventDefault();
    }
  });

  return win;
}
