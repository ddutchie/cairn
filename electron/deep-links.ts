/**
 * cairn:// deep links (remote-MCP OAuth callbacks) and the single-instance
 * lock that delivers them on Windows/Linux. Links that arrive before the
 * renderer is ready are buffered and replayed by markRendererReadyForDeepLinks.
 */

import { app, BrowserWindow } from "electron";
import path from "path";
import { DEEP_LINK_SCHEME, parseOAuthCallback, completeServerAuth } from "./lib/mcp-oauth";
import { sendIpcEvent } from "./ipc/registry";

/** Find the first cairn:// deep link in a process argv array, if any. */
function deepLinkFromArgv(argv: string[]): string | null {
  return argv.find((a) => typeof a === "string" && a.startsWith(`${DEEP_LINK_SCHEME}://`)) ?? null;
}

/** Buffer for a deep link that arrives before the renderer is ready. */
let _pendingDeepLink: string | null = null;
/** True once the main window's renderer has finished loading (listeners attached). */
let _rendererReady = false;

/** Route a cairn:// deep link. Currently only OAuth callbacks are handled. */
async function handleDeepLink(rawUrl: string): Promise<void> {
  const cb = parseOAuthCallback(rawUrl);
  if (!cb) return;
  const win = BrowserWindow.getAllWindows()[0] ?? null;
  // If the renderer isn't ready to receive the result event yet, buffer the raw
  // link and let the post-load flush replay it through this same path.
  if (!win || !_rendererReady) {
    _pendingDeepLink = rawUrl;
    return;
  }
  if (win.isMinimized()) win.restore();
  win.focus();
  const result = await completeServerAuth(cb);
  // Tell the renderer how it went so Settings can refresh the connection state.
  sendIpcEvent(win.webContents, "tools:oauthCallback", result);
}

/** Flush any buffered deep link once the renderer is ready. */
function flushPendingDeepLink(): void {
  const link = _pendingDeepLink ?? deepLinkFromArgv(process.argv);
  _pendingDeepLink = null;
  if (link) void handleDeepLink(link);
}


/** Call once the main window's renderer has loaded: replays any buffered link. */
export function markRendererReadyForDeepLinks(): void {
  _rendererReady = true;
  flushPendingDeepLink();
}

/**
 * Register the cairn:// protocol handler, take the single-instance lock (a
 * second launch quits and focuses the first), and route incoming links. Used
 * by the remote-MCP OAuth flow: the authorization server redirects to
 * cairn://oauth/callback?code=…&state=…, which the OS hands back as an
 * open-url event (macOS) or a process argv entry (Windows/Linux).
 */
export function registerDeepLinks(isDev: boolean): void {
  if (isDev && process.platform === "win32" && process.argv.length >= 2) {
    // In dev on Windows the executable is electron.exe with our entry script as
    // argv[1]; the launcher must be registered with that path so the OS can
    // re-invoke us for a deep link.
    app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME, process.execPath, [path.resolve(process.argv[1])]);
  } else {
    app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME);
  }

  const gotTheLock = app.requestSingleInstanceLock();

  if (!gotTheLock) {
    app.quit();
  } else {
    app.on("second-instance", (_event, argv) => {
      // Focus the existing window, and pick up a deep link passed on the relaunch
      // argv (Windows/Linux delivery path for cairn://…).
      const allWindows = BrowserWindow.getAllWindows();
      if (allWindows.length > 0) {
        if (allWindows[0].isMinimized()) allWindows[0].restore();
        allWindows[0].focus();
      }
      const link = deepLinkFromArgv(argv);
      if (link) void handleDeepLink(link);
    });
  }

  // macOS delivers deep links via open-url (can fire before whenReady on cold
  // start; handleDeepLink buffers until the renderer is ready).
  app.on("open-url", (event, url) => {
    event.preventDefault();
    void handleDeepLink(url);
  });
}
