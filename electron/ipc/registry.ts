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
  listeners.set(channel, handler as IpcHandler);
  ipcMain.on(channel, handler as IpcHandler);
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
  // Send to all mobile clients
  if (mobileBroadcastCallback) {
    mobileBroadcastCallback(channel, payload);
  }
}
