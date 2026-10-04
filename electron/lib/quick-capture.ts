/**
 * Global quick capture — an OS-wide shortcut that brings Cairn forward and
 * opens the Quick Capture dialog (add a backlog card or a note without
 * navigating). Also reachable from the tray menu.
 */

import { app, globalShortcut, type BrowserWindow } from "electron";

/** Default accelerator. ⌘⇧Space / Ctrl⇧Space rarely collides with OS shortcuts. */
export const QUICK_CAPTURE_ACCELERATOR = "CommandOrControl+Shift+Space";
export const QUICK_CAPTURE_CHANNEL = "app:quick-capture";

export function openQuickCapture(win: BrowserWindow): void {
  if (win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  win.webContents.send(QUICK_CAPTURE_CHANNEL);
}

/**
 * Register the global shortcut for `win`. Returns false when another app owns
 * the accelerator (registration is first-come); the tray item still works.
 */
export function registerQuickCapture(win: BrowserWindow): boolean {
  let ok = false;
  try {
    ok = globalShortcut.register(QUICK_CAPTURE_ACCELERATOR, () => openQuickCapture(win));
  } catch (e) {
    console.warn("[quick-capture] shortcut registration failed:", e);
  }
  if (!ok) console.warn(`[quick-capture] ${QUICK_CAPTURE_ACCELERATOR} is taken by another app; use the tray menu instead.`);
  app.once("will-quit", () => globalShortcut.unregister(QUICK_CAPTURE_ACCELERATOR));
  return ok;
}
