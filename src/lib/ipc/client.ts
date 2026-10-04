/**
 * Base for the renderer's typed IPC clients (`src/lib/ipc/*`).
 *
 * Preload's `invoke` already unwraps the `{ data } | { error }` envelope and
 * rejects on `{ error }`, so a client call resolves to the typed result or
 * throws. Clients throw `IpcUnavailableError` outside the desktop app instead
 * of every call site checking `window.electron?.x` first.
 */

import { CairnEvents } from "@/lib/events";

export type ElectronApi = NonNullable<Window["electron"]>;

export class IpcUnavailableError extends Error {
  constructor() {
    super("This needs the Cairn desktop app.");
    this.name = "IpcUnavailableError";
  }
}

/** True when running inside Electron with the preload bridge attached. */
export function hasElectron(): boolean {
  return typeof window !== "undefined" && !!window.electron;
}

/** The preload bridge, or throws `IpcUnavailableError`. */
export function requireElectron(): ElectronApi {
  if (typeof window === "undefined" || !window.electron) throw new IpcUnavailableError();
  return window.electron;
}

/** A user-facing message for a rejected IPC call. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return "Something went wrong.";
}

/**
 * Log a failed IPC call and surface it as an app toast (via the same
 * `cairn:ipc-error` event the store helpers use). For background calls whose
 * failure has no inline UI — use it instead of an empty `catch {}`.
 * Off-Electron failures are not reported: the feature simply isn't there.
 */
export function reportIpcError(err: unknown, context?: string): void {
  if (err instanceof IpcUnavailableError) return;
  const message = errorMessage(err);
  console.error(`[cairn:ipc]${context ? ` ${context}:` : ""}`, err);
  window.dispatchEvent(CairnEvents.ipcError(context ? `${context}: ${message}` : message));
}
