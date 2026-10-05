/**
 * The only ipcRenderer calls in preload: every domain module builds its slice
 * of `window.electron` from these typed helpers over shared/ipc/contract.ts.
 */

import { ipcRenderer, type IpcRendererEvent } from "electron";
import type {
  IpcArgs, IpcChannel, IpcEventChannel, IpcEvents, IpcReturn, IpcSendArgs, IpcSendChannel,
} from "../../shared/ipc/contract";

/**
 * Invoke a channel in the typed IPC contract and unwrap its envelope: every
 * handler returns { data } | { error } via handle(), so callers receive the
 * typed result directly or a rejection on error.
 */
export function invokeContract<C extends IpcChannel>(channel: C, ...args: IpcArgs<C>): Promise<IpcReturn<C>> {
  return ipcRenderer.invoke(channel, args[0]).then((result: { data: IpcReturn<C> } | { error: string }) => {
    if (result && typeof result === "object" && "error" in result) throw new Error(result.error);
    return result.data;
  });
}

/** Subscribe to a contract push event; returns the unsubscribe function. */
export function onIpcEvent<E extends IpcEventChannel>(channel: E, cb: (payload: IpcEvents[E]) => void): () => void {
  const handler = (_event: IpcRendererEvent, payload: IpcEvents[E]) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => { ipcRenderer.off(channel, handler); };
}

/** Fire-and-forget message to a main-process `registerIpcOn` listener. */
export function sendContract<S extends IpcSendChannel>(channel: S, ...args: IpcSendArgs<S>): void {
  ipcRenderer.send(channel, ...args);
}
