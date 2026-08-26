import { ipcMain, BrowserWindow } from "electron";
import type { IpcMainInvokeEvent, IpcMainEvent } from "electron";

/**
 * Erased storage type for the internal handler/listener maps. Event is `unknown`
 * here because both `IpcMainInvokeEvent` and `IpcMainEvent` widen to it; concrete
 * registration signatures ({@link IpcHandleHandler} / {@link IpcOnHandler}) type
 * the event properly for callers.
 */
export type IpcHandler<T extends unknown[] = unknown[]> = (
  event: unknown,
  ...args: T
) => unknown;

/** Handler signature for {@link registerIpcHandle} (ipcMain.handle). */
export type IpcHandleHandler<T extends unknown[] = unknown[]> = (
  event: IpcMainInvokeEvent,
  ...args: T
) => unknown;

/** Handler signature for {@link registerIpcOn} (ipcMain.on). */
export type IpcOnHandler<T extends unknown[] = unknown[]> = (
  event: IpcMainEvent,
  ...args: T
) => unknown;

const handlers = new Map<string, IpcHandler>();
const listeners = new Map<string, IpcHandler>();
const registeredListeners = new Map<string, IpcHandler>();

let mobileBroadcastCallback: ((channel: string, payload: unknown) => void) | null = null;

/**
 * Decide whether a completed `db:*` channel should auto-broadcast `db:changed`
 * (which triggers a full snapshot re-hydration in every window + mobile client).
 *
 * Write channels broadcast; read channels must NOT. The previous implementation
 * was a pure denylist of read channels, defaulting any *unlisted* `db:*` channel
 * to "write" — so a forgotten read channel would silently fire `db:changed` on
 * every call (a re-hydration storm that never errors, just wastes work).
 *
 * The codebase follows a strict `db:<entity>:<action>` naming convention, so we
 * primarily classify by the trailing action verb: reads are the well-known
 * read verbs below. A small denylist of irregularly-named read channels
 * (e.g. `db:chat:threads`, `db:snapshot`) covers the cases that don't end in a
 * read verb. Anything else is treated as a write.
 */
const READ_ACTIONS = new Set([
  "list",
  "get",
  "search",
  "neighbors",
  "ready",
  "messages",
  "threads",
  "fetch", // db:flow:url:fetch — fetches URL metadata, no DB write
]);

// Read channels whose names don't end in a recognised read verb.
const READ_CHANNELS = new Set([
  "db:snapshot",
  "db:hasData",
  "db:mcpQuery",
]);

function isWriteChannel(channel: string): boolean {
  if (!channel.startsWith("db:")) return false;
  if (READ_CHANNELS.has(channel)) return false;
  const action = channel.slice(channel.lastIndexOf(":") + 1);
  if (READ_ACTIONS.has(action)) return false;
  return true;
}

/** Exported for unit testing the read/write classification. */
export const __isWriteChannel = isWriteChannel;

/**
 * Register a handler that maps to ipcMain.handle.
 */
export function registerIpcHandle<T extends unknown[]>(
  channel: string,
  handler: IpcHandleHandler<T>
): void {
  // Workspace reinitialisation re-registers the live surface. Electron rejects
  // duplicate invoke handlers, and duplicate listeners would run a turn twice.
  ipcMain.removeHandler?.(channel);
  ipcMain.removeAllListeners?.(channel);
  const wrappedHandler = async (event: unknown, ...args: unknown[]) => {
    const result = await handler(event as IpcMainInvokeEvent, ...(args as T));
    if (isWriteChannel(channel)) {
      broadcastEvent("db:changed", null);
    }
    return result;
  };
  handlers.set(channel, wrappedHandler);
  ipcMain.handle(channel, wrappedHandler);
}

/**
 * Register a listener that maps to ipcMain.on.
 */
export function registerIpcOn<T extends unknown[]>(
  channel: string,
  handler: IpcOnHandler<T>
): void {
  ipcMain.removeHandler?.(channel);
  const previous = registeredListeners.get(channel);
  if (previous) ipcMain.removeListener?.(channel, previous as never);
  listeners.set(channel, handler as IpcHandler);
  const registered = handler as IpcHandler;
  registeredListeners.set(channel, registered);
  ipcMain.on(channel, registered);
}

/**
 * Retrieve a registered handler or listener by channel name.
 */
export function getIpcHandler(channel: string): IpcHandler | undefined {
  return handlers.get(channel) || listeners.get(channel);
}

/**
 * Set the mobile broadcasting callback (used by mobile-server.ts on start).
 */
export function setMobileBroadcastCallback(cb: ((channel: string, payload: unknown) => void) | null): void {
  mobileBroadcastCallback = cb;
}

/**
 * Strip HITL nonces before forwarding to mobile — desktop needs the nonce
 * to answer approvals/questions, but mobile must never receive it (widens
 * the approval bypass surface via the mobile sync channel).
 */
function stripNonceForMobile(payload: unknown): unknown {
  if (payload === null || typeof payload !== "object") return payload;
  const obj = payload as Record<string, unknown>;
  const hasNonce = "nonce" in obj;
  const data = obj["data"] as unknown;
  const hasDataNonce = data !== null && typeof data === "object" && "nonce" in (data as Record<string, unknown>);
  if (!hasNonce && !hasDataNonce) return payload;
  // Shallow clone outer
  const clone: Record<string, unknown> = { ...obj };
  if (hasNonce) delete clone["nonce"];
  if (hasDataNonce) {
    const dataObj = data as Record<string, unknown>;
    clone["data"] = { ...dataObj };
    delete (clone["data"] as Record<string, unknown>)["nonce"];
  }
  return clone;
}

/**
 * Broadcast an event to all Electron windows and all active mobile clients.
 */
export function broadcastEvent(channel: string, payload: unknown): void {
  // Send to all Electron windows
  const allWindows = BrowserWindow.getAllWindows();
  for (const win of allWindows) {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, payload);
    }
  }
  // Send to all mobile clients — strip approval/question nonces so they never
  // leak over the mobile sync transport (registry mobileBroadcastCallback).
  if (mobileBroadcastCallback) {
    const mobilePayload = stripNonceForMobile(payload);
    mobileBroadcastCallback(channel, mobilePayload);
  }
}

// ── Centralised session broadcast ─────────────────────────────────────────
//
// `broadcastEvent` (all windows + mobile) vs `broadcastToChat` (chat
// participants only: main + pop-out) was previously split across
// `registry.ts` and `chat-popout.ts` with only a comment distinguishing
// them. Centralise the intent here so call-sites express scope explicitly.
// `chat` scope is participant-gated and deliberately excludes mobile (so HITL
// nonces never leave desktop). Coding sessions use `all` because they are not
// participant-gated.

export type BroadcastScope = "all" | "chat";

/** Single entry-point for session:* broadcasts with an explicit scope. */
export function broadcastSession(
  channel: string,
  payload: unknown,
  scope: BroadcastScope = "all",
  excludeId?: number,
): void {
  if (scope === "chat") {
    // Lazy import avoids circular dep registry ↔ chat-popout (the participant
    // set lives in chat-popout.ts). Fall back to broadcastEvent if the popout
    // module isn't loaded yet (e.g. tests).
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { broadcastToChat } = require("../chat-popout") as {
        broadcastToChat: (c: string, p: unknown, e?: number) => void;
      };
      broadcastToChat(channel, payload, excludeId);
      // The sender's own window already received via event.sender.send in
      // chat.ts; broadcastToChat fans out to the *other* participant(s).
      // For non-chat-triggered broadcasts (e.g. busy errors), also fan out
      // via broadcastEvent's mobile path is intentionally skipped — chat-only.
      return;
    } catch {
      // Fall through to broadcastEvent (no participant set available).
    }
  }
  broadcastEvent(channel, payload);
}
