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

function isWriteChannel(channel: string): boolean {
  if (!channel.startsWith("db:")) return false;

  const readChannels = [
    "db:snapshot",
    "db:hasData",
    "db:workspace:list",
    "db:project:list",
    "db:note:list",
    "db:column:list",
    "db:card:list",
    "db:card:ready",
    "db:flow:get",
    "db:tag:list",
    "db:chat:threads",
    "db:chat:messages",
    "db:piSession:list",
    "db:piSession:messages",
    "db:graph:get",
    "db:graph:neighbors",
    "db:mcpQuery"
  ];

  return !readChannels.includes(channel);
}

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
