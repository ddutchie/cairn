/**
 * Global quick capture — an OS-wide shortcut that brings Cairn forward and
 * opens the Quick Capture dialog (add a backlog card or a note without
 * navigating). Also reachable from the tray menu.
 */

import { app, globalShortcut, type BrowserWindow } from "electron";
import type { IpcEventChannel } from "../../shared/ipc/contract";

/** Default accelerator. ⌘⇧Space / Ctrl⇧Space rarely collides with OS shortcuts. */
export const QUICK_CAPTURE_ACCELERATOR = "CommandOrControl+Shift+Space";
/** Payload-less contract event (`IpcEvents`). */
export const QUICK_CAPTURE_CHANNEL = "app:quick-capture" satisfies IpcEventChannel;

/** Resolves the live main window (recreating it if the user closed it on macOS). */
export type MainWindowGetter = () => BrowserWindow | null;

export function openQuickCapture(getWin: MainWindowGetter): void {
  const win = getWin();
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  // A freshly recreated window may still be loading; deliver once it's ready.
  if (win.webContents.isLoading()) win.webContents.once("did-finish-load", () => win.webContents.send(QUICK_CAPTURE_CHANNEL));
  else win.webContents.send(QUICK_CAPTURE_CHANNEL);
}

/**
 * Register the global shortcut for `win`. Returns false when another app owns
 * the accelerator (registration is first-come); the tray item still works.
 */
let unregisterHooked = false;

export function registerQuickCapture(getWin: MainWindowGetter): boolean {
  let ok = false;
  try {
    ok = globalShortcut.register(QUICK_CAPTURE_ACCELERATOR, () => openQuickCapture(getWin));
  } catch (e) {
    console.warn("[quick-capture] shortcut registration failed:", e);
  }
  if (!ok) console.warn(`[quick-capture] ${QUICK_CAPTURE_ACCELERATOR} is taken by another app; use the tray menu instead.`);
  if (!unregisterHooked) {
    unregisterHooked = true;
    app.once("will-quit", () => globalShortcut.unregister(QUICK_CAPTURE_ACCELERATOR));
  }
  return ok;
}
