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

import { app, BrowserWindow, shell } from "electron";
import path from "path";
import { readThemeSurface } from "./lib/theme-surface";
import { bindChatPopoutSession, chatParticipantIdsExcept, resolveChatPopoutSession, type ChatPopoutPayload } from "../shared/agent/chat-popout";
import type { DbContext } from "./ipc/result-helpers";
import { handle } from "./ipc/result-helpers";
import { registerIpcHandle } from "./ipc/registry";
import { getSessionProfile } from "./db/queries";

const isDev = !app.isPackaged;

/**
 * Map of webContents IDs that participate in the active chat session.
 * Values are stored as webContents.id (not BrowserWindow.id — they differ).
 */
const chatParticipants = new Set<number>();

/** Pending pop-out payloads keyed by generation. Replaces the old singleton which raced on double popOut. */
let pendingGenerationCounter = 0;
const pendingByGeneration = new Map<number, ChatPopoutPayload>();
let pendingGenerationForWindow: number | null = null;

let popoutWindow: BrowserWindow | null = null;

/** Track the main window's webContents ID so we can find it later. */
let mainWindowWebContentsId: number | null = null;

function loadPopupUrl(win: BrowserWindow): void {
  if (isDev) {
    // The popout has its own renderer and can otherwise retain an older
    // document after the Next dev server has rebuilt /chat. Clear this
    // renderer's cache and use a unique URL for every new window.
    const url = `http://localhost:3000/chat?popout=${Date.now()}`;
    void win.webContents.session.clearCache().finally(() => {
      if (!win.isDestroyed()) void win.loadURL(url);
    });
  } else {
    void win.loadURL("app://./chat/index.html");
  }
}

export function createChatPopoutWindow(): BrowserWindow {
  if (popoutWindow && !popoutWindow.isDestroyed()) {
    popoutWindow.focus();
    return popoutWindow;
  }

  const isWin = process.platform === "win32";
  const { surface, bg } = readThemeSurface();
  const win = new BrowserWindow({
    width: 420,
    height: 640,
    minWidth: 320,
    minHeight: 400,
    title: "Cairn Chat",
    // Match the main window: the native title text is hidden and the shared
    // React TitleBar owns the visible chrome. On macOS this leaves the traffic
    // lights inset over the first 40px of content; on Windows the native
    // controls are overlaid into the same custom bar.
    titleBarStyle: isWin ? "hidden" : "hiddenInset",
    ...(isWin && {
      titleBarOverlay: {
        color: surface,
        symbolColor: "#888888",
        height: 39,
      },
    }),
    alwaysOnTop: true,
    backgroundColor: bg,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      // H7: sandbox:false — same risk as main window (see main.ts:207 TODO).
      // Roadmap to sandbox:true is tracked separately; keep false until preload
      // isolation + utilityProcess hardening is complete.
      sandbox: false,
    },
  });

  // C2: deny new windows from pop-out and only allow safe external schemes.
  win.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === "https:" || parsed.protocol === "http:" || parsed.protocol === "mailto:") {
        shell.openExternal(url);
      }
    } catch { /* malformed URL — deny */ }
    return { action: "deny" };
  });

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

  loadPopupUrl(win);
  // Match the main window's development workflow: the popout has its own
  // WebContents, so DevTools must be opened explicitly for this window.
  if (isDev && process.env.CAIRN_NO_DEVTOOLS !== "1") {
    win.webContents.openDevTools({ mode: "detach" });
  }

  const popoutWebContentsId = win.webContents.id;

  win.on("closed", () => {
    chatParticipants.delete(popoutWebContentsId);
    // Clean the pending generation tied to this window so the map doesn't leak orphaned payloads.
    if (pendingGenerationForWindow !== null) {
      pendingByGeneration.delete(pendingGenerationForWindow);
      pendingGenerationForWindow = null;
    }
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
  // Clean any still-pending generation for this window (e.g. popIn before Ready consumed it).
  if (pendingGenerationForWindow !== null) {
    pendingByGeneration.delete(pendingGenerationForWindow);
    pendingGenerationForWindow = null;
  }
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
  for (const id of chatParticipantIdsExcept(chatParticipants, excludeId)) {
    const win = findWindowByWebContentsId(id);
    if (win) {
      win.webContents.send(channel, payload);
    }
  }
}

export function registerChatPopoutHandlers(ctx: DbContext): void {
  // Main window requests a pop-out: stores state, creates pop-out window
  registerIpcHandle("chat:popOut", (event, rawPayload: unknown) =>
    handle(async () => {
      const payload = bindChatPopoutSession(rawPayload);
      if (!payload) return { ok: false, reason: "invalid-payload" } as const;
      const stored = getSessionProfile(ctx.db, payload.sessionId);
      const canonical = resolveChatPopoutSession(payload, stored);
      if (!canonical) return { ok: false, reason: "profile-mismatch" } as const;
      mainWindowWebContentsId = event.sender.id;
      chatParticipants.add(event.sender.id);

    // Generation counter prevents the old singleton race where a second popOut
    // overwrote pendingChatSession before popoutReady consumed it.
    // Wrap as uint32 so a long-lived session never grows past MAX_SAFE_INTEGER.
    pendingGenerationCounter = (pendingGenerationCounter + 1) >>> 0;
    // Avoid 0 which is falsy for some checks; wrap-around from 2^32-1 goes to 1.
    if (pendingGenerationCounter === 0) pendingGenerationCounter = 1;
    const generation = pendingGenerationCounter;
      // Replace safely: drop any still-pending orphan for the not-yet-loaded window.
      if (pendingGenerationForWindow !== null && pendingByGeneration.has(pendingGenerationForWindow)) {
        pendingByGeneration.delete(pendingGenerationForWindow);
      }
      pendingByGeneration.set(generation, canonical);
      pendingGenerationForWindow = generation;

        // If a pop-out window already exists, focus it and push the updated session
      // directly instead of losing the payload in a singleton overwrite.
      if (popoutWindow && !popoutWindow.isDestroyed()) {
        popoutWindow.focus();
        // If the pop-out renderer is already loaded, deliver immediately; otherwise
        // the pending map will be consumed by the next popoutReady.
        try {
          if (!popoutWindow.webContents.isLoading()) {
            popoutWindow.webContents.send("chat:sessionUpdated", canonical);
            pendingByGeneration.delete(generation);
            pendingGenerationForWindow = null;
          }
        } catch { /* ignore send failure during window teardown */ }
        return { ok: true } as const;
      }

      createChatPopoutWindow();
      return { ok: true } as const;
    }),
  );

  // Pop-out page signals it is ready — register as participant, return stored state
  registerIpcHandle("chat:popoutReady", (event) =>
    handle(async () => {
      if (event.sender.id !== popoutWindow?.webContents.id) {
        return { sessionId: "", activeProjectId: null, profile: "chat" as const, workspaceId: null, cwd: null, reason: "not-popout" as const };
      }
      chatParticipants.add(event.sender.id);
      const gen = pendingGenerationForWindow;
      const session = gen !== null ? (pendingByGeneration.get(gen) ?? null) : null;
      if (gen !== null) {
        pendingByGeneration.delete(gen);
        // Keep pendingGenerationForWindow for the live window so a reload can
        // re-deliver if needed? No — clear after consumption; next popOut will assign new.
        // But retain the generation on the window until closed so direct-send path knows
        // which entry is live. We clear the map entry but keep the pointer only if we
        // want reload resilience; simplest is to clear pointer and re-assign on next popOut.
        // For now clear it so duplicate Ready calls don't deliver stale.
        pendingGenerationForWindow = null;
      }
      const stored = session ? getSessionProfile(ctx.db, session.sessionId) : null;
      const canonical = session && resolveChatPopoutSession(session, stored);
      if (session && !canonical) {
        // Profile mismatch surfaced here — tell the renderer why the session is empty.
        return { sessionId: "", activeProjectId: null, profile: "chat" as const, workspaceId: null, cwd: null, reason: "profile-mismatch" as const };
      }
      return canonical ?? { sessionId: "", activeProjectId: null, profile: "chat" as const, workspaceId: null, cwd: null };
    }),
  );

  // Main window requests the pop-out to come back (clicked placeholder button)
  registerIpcHandle("chat:requestPopIn", (event) =>
    handle(async () => {
      if (event.sender.id !== mainWindowWebContentsId) {
        return { ok: false, reason: "not-main-window" } as const;
      }
      if (popoutWindow && !popoutWindow.isDestroyed()) {
        popoutWindow.webContents.send("chat:requestPopIn");
      }
      return { ok: true } as const;
    }),
  );

  // Pop-out window requests pop-in. Conversation state is already shared by
  // the session log and the session:event broadcast; no final-state merge.
  registerIpcHandle("chat:popIn", (event, payload: { sessionId: string }) =>
    handle(async () => {
      if (event.sender.id !== popoutWindow?.webContents.id) {
        return { ok: false, reason: "not-popout" } as const;
      }
      const senderId = event.sender.id;
      // Find the main window by its tracked webContents ID (not BrowserWindow.id)
      const mainWin = findMainWindow();
      if (mainWin) {
        mainWin.webContents.send("chat:poppedIn", { sessionId: payload.sessionId });
      }
      closeChatPopoutWindow();
      chatParticipants.delete(senderId);
      return { ok: true } as const;
    }),
  );
}
