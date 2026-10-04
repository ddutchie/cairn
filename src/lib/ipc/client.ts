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

/**
 * True when running inside Electron with the preload bridge attached — and,
 * when `domain` is given, when the bridge exposes that namespace (test and
 * web shims only stub some of them).
 */
export function hasElectron(domain?: keyof ElectronApi): boolean {
  if (typeof window === "undefined" || !window.electron) return false;
  return domain === undefined || window.electron[domain] != null;
}

/** The preload bridge, or throws `IpcUnavailableError`. */
export function requireElectron(): ElectronApi {
  if (typeof window === "undefined" || !window.electron) throw new IpcUnavailableError();
  return window.electron;
}

/**
 * Run `fn` against the bridge. A missing bridge becomes a rejected promise
 * (not a synchronous throw), so callers only ever handle rejections.
 */
export function electronCall<T>(fn: (api: ElectronApi) => Promise<T>): Promise<T> {
  try {
    return fn(requireElectron());
  } catch (err) {
    return Promise.reject(err);
  }
}

/**
 * `electronCall` scoped to one bridge namespace; a bridge without that
 * namespace counts as unavailable too.
 */
export function domainCall<K extends keyof ElectronApi, T>(
  domain: K,
  fn: (api: NonNullable<ElectronApi[K]>) => Promise<T>,
): Promise<T> {
  return electronCall((e) => {
    const api = e[domain];
    if (api == null) throw new IpcUnavailableError();
    return fn(api as NonNullable<ElectronApi[K]>);
  });
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

/**
 * Fire-and-forget a write: failures are reported via `reportIpcError` rather
 * than left as unhandled rejections.
 */
export function persist(promise: Promise<unknown>, context: string): void {
  promise.catch((err: unknown) => reportIpcError(err, context));
}
