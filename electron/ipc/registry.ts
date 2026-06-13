import { ipcMain, BrowserWindow } from "electron";

export type IpcHandler = (event: unknown, ...args: unknown[]) => unknown;

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
export function registerIpcHandle(channel: string, handler: IpcHandler): void {
  const wrappedHandler = async (event: unknown, ...args: unknown[]) => {
    const result = await handler(event, ...args);
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
export function registerIpcOn(channel: string, handler: IpcHandler): void {
  listeners.set(channel, handler);
  ipcMain.on(channel, handler);
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
