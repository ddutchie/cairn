/**
 * Cairn — Pop-out chat window management
 *
 * When a chat pop-out is active, the main window's chat panel shows a
 * placeholder. All chat interactions happen in the pop-out window.
 * The main process relays only session identity between windows. Session
 * history and events remain owned by the canonical dsh session surface.
 *
 * State flow:
 *   popOut  → main renderer sends a session id → main process creates pop-out
 *   popIn   → pop-out sends its session id → main process closes pop-out
 */

import { app, BrowserWindow, ipcMain } from "electron";
import path from "path";

const isDev = !app.isPackaged;

/**
 * Map of webContents IDs that participate in the active chat session.
 * Values are stored as webContents.id (not BrowserWindow.id — they differ).
 */
const chatParticipants = new Set<number>();

/** Session identity sent from the main window, pending delivery to the pop-out. */
let pendingChatSession: { sessionId: string; activeProjectId: string | null } | null = null;

let popoutWindow: BrowserWindow | null = null;

/** Track the main window's webContents ID so we can find it later. */
let mainWindowWebContentsId: number | null = null;

function loadPopupUrl(win: BrowserWindow): void {
  if (isDev) {
    win.loadURL("http://localhost:3000/chat");
  } else {
    win.loadURL("app://./chat/index.html");
  }
}

export function createChatPopoutWindow(): BrowserWindow {
  if (popoutWindow && !popoutWindow.isDestroyed()) {
    popoutWindow.focus();
    return popoutWindow;
  }

  const win = new BrowserWindow({
    width: 420,
    height: 640,
    minWidth: 320,
    minHeight: 400,
    title: "Cairn Chat",
    alwaysOnTop: true,
    backgroundColor: "#0d0d0d",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  loadPopupUrl(win);

  const popoutWebContentsId = win.webContents.id;

  win.on("closed", () => {
    chatParticipants.delete(popoutWebContentsId);
    // Notify the main window that the pop-out closed unexpectedly (e.g. Cmd+W)
    const mainWin = findMainWindow();
    if (mainWin) {
      mainWin.webContents.send("chat:poppedOutClosed");
    }
    popoutWindow = null;
  });

  popoutWindow = win;
  return win;
}

export function closeChatPopoutWindow(): void {
  if (popoutWindow && !popoutWindow.isDestroyed()) {
    popoutWindow.close();
  }
  popoutWindow = null;
}

/** Find the main window by its tracked webContents ID. */
function findMainWindow(): BrowserWindow | null {
  if (mainWindowWebContentsId === null) return null;
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.webContents.id === mainWindowWebContentsId && !win.isDestroyed()) {
      return win;
    }
  }
  return null;
}

/** Find a BrowserWindow given one of its webContents' IDs. */
function findWindowByWebContentsId(id: number): BrowserWindow | null {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.webContents.id === id && !win.isDestroyed()) {
      return win;
    }
  }
  return null;
}

/**
 * Send an event to every chat participant EXCEPT excludeId.
 * The originator already receives via event.sender.send in chat.ts.
 */
export function broadcastToChat(channel: string, payload: unknown, excludeId?: number): void {
  for (const id of chatParticipants) {
    if (id === excludeId) continue;
    const win = findWindowByWebContentsId(id);
    if (win) {
      win.webContents.send(channel, payload);
    }
  }
}

export function registerChatPopoutHandlers(): void {
  // Main window requests a pop-out: stores state, creates pop-out window
  ipcMain.handle("chat:popOut", (event, payload: { sessionId: string; activeProjectId: string | null }) => {
    mainWindowWebContentsId = event.sender.id;
    chatParticipants.add(event.sender.id);
    pendingChatSession = payload;
    createChatPopoutWindow();
    return { data: { ok: true } };
  });

  // Pop-out page signals it is ready — register as participant, return stored state
  ipcMain.handle("chat:popoutReady", (event) => {
    if (event.sender.id !== popoutWindow?.webContents.id) {
      return { data: { sessionId: "", activeProjectId: null } };
    }
    chatParticipants.add(event.sender.id);
    const session = pendingChatSession;
    pendingChatSession = null;
    return { data: session ?? { sessionId: "", activeProjectId: null } };
  });

  // Main window requests the pop-out to come back (clicked placeholder button)
  ipcMain.handle("chat:requestPopIn", (event) => {
    if (event.sender.id !== mainWindowWebContentsId) {
      return { data: { ok: false } };
    }
    if (popoutWindow && !popoutWindow.isDestroyed()) {
      popoutWindow.webContents.send("chat:requestPopIn");
    }
    return { data: { ok: true } };
  });

  // Pop-out window requests pop-in. Conversation state is already shared by
  // the session log and the session:event broadcast; no final-state merge.
  ipcMain.handle("chat:popIn", (event, payload: { sessionId: string }) => {
    if (event.sender.id !== popoutWindow?.webContents.id) {
      return { data: { ok: false } };
    }
    const senderId = event.sender.id;
    // Find the main window by its tracked webContents ID (not BrowserWindow.id)
    const mainWin = findMainWindow();
    if (mainWin) {
      mainWin.webContents.send("chat:poppedIn", { sessionId: payload.sessionId });
    }
    closeChatPopoutWindow();
    chatParticipants.delete(senderId);
    return { data: { ok: true } };
  });
}
