/**
 * Shared IPC helpers for Zustand store slices.
 *
 * All slices import from here instead of copy-pasting these three functions.
 *
 * All handlers now return IpcResult<T> = { data: T } | { error: string }.
 * The helpers here detect { error } responses and dispatch a cairn:ipc-error
 * CustomEvent so the app shell can surface a toast to the user.
 */

import { CairnEvents } from "@/lib/events";
import { ownWriteGuard } from "@/lib/history";

export function isElectron(): boolean {
  return typeof window !== "undefined" && !!window.electron;
}

function handleResult(result: unknown): void {
  if (result && typeof result === "object" && "error" in result) {
    const message = (result as { error: string }).error;
    console.error("[cairn:ipc:error]", message);
    window.dispatchEvent(CairnEvents.ipcError(message));
  }
}

/**
 * Fire-and-forget IPC call.
 * Checks the response for { error } and dispatches a cairn:ipc-error event.
 */
export function ipc(
  fn: (e: NonNullable<Window["electron"]>) => Promise<unknown> | undefined
): void {
  if (!isElectron() || !window.electron) return;
  ownWriteGuard.touch();
  fn(window.electron)
    ?.then(handleResult)
    ?.catch?.((err: unknown) => {
      console.error("[cairn:ipc]", err);
    });
}

/**
 * Awaitable IPC call. Resolves to void on success or error (never rejects).
 * Checks the response for { error } and dispatches a cairn:ipc-error event.
 */
export function ipcAwait(
  fn: (e: NonNullable<Window["electron"]>) => Promise<unknown> | undefined
): Promise<void> {
  ownWriteGuard.touch();
  if (!isElectron() || !window.electron) return Promise.resolve();
  return (fn(window.electron) ?? Promise.resolve())
    .then((result) => { handleResult(result); })
    .catch((err: unknown) => {
      console.error("[cairn:ipc]", err);
    });
}

/**
 * Awaitable IPC call that returns the raw IpcResult<T>.
 * Use when the caller needs to inspect { error } (e.g. circular dep check).
 */
export async function ipcAwaitResult<T>(
  fn: (e: NonNullable<Window["electron"]>) => Promise<{ data: T } | { error: string } | undefined>
): Promise<{ data: T } | { error: string }> {
  ownWriteGuard.touch();
  if (!isElectron() || !window.electron) return { error: "Not in Electron" };
  try {
    const result = await (fn(window.electron) ?? Promise.resolve(undefined));
    return result ?? { error: "No response" };
  } catch (err) {
    return { error: String(err) };
  }
}
