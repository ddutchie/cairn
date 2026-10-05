import { ipcMain, BrowserWindow } from "electron";
import type { IpcMainInvokeEvent, IpcMainEvent, WebContents } from "electron";
import { IPC_WRITE_CHANNELS } from "../../shared/ipc/contract";
import type { IpcChannel, IpcArgs, IpcReturn, IpcEventChannel, IpcEventArgs } from "../../shared/ipc/contract";
import type { IpcResult } from "./result-helpers";
import { isMobileChannel } from "./mobile-access";

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
 * Observer wrapped around every write channel's handler (`writes: true`). main.ts
 * installs one that records the change-feed seq range each window wrote, so the
 * change feed can tell a window which changes it already holds optimistically.
 * `begin` runs before the handler; `end` after it settles (before db:changed is
 * broadcast, so the attribution is in place when the renderer asks), with how
 * long the handler took — a slow async handler (e.g. an LLM call) spans writes
 * from other processes, so the observer should not claim its range.
 */
export interface WriteObserver {
  /** Returns an opaque token handed back to `end`. */
  begin: () => unknown;
  end: (begin: unknown, senderId: number | undefined, elapsedMs: number) => void;
}
let writeObserver: WriteObserver | null = null;
export function setWriteObserver(observer: WriteObserver | null): void {
  writeObserver = observer;
}

/**
 * Register a handler that maps to ipcMain.handle. A write handler runs inside
 * the {@link WriteObserver} and broadcasts `db:changed` when it completes.
 */
function registerIpcHandle<T extends unknown[]>(
  channel: string,
  handler: IpcHandleHandler<T>,
  isWrite: boolean,
): void {
  // Workspace reinitialisation re-registers the live surface. Electron rejects
  // duplicate invoke handlers, and duplicate listeners would run a turn twice.
  ipcMain.removeHandler?.(channel);
  ipcMain.removeAllListeners?.(channel);
  const wrappedHandler = async (event: unknown, ...args: unknown[]) => {
    const observer = isWrite ? writeObserver : null;
    let begin: unknown;
    const startedAt = Date.now();
    try { if (observer) begin = observer.begin(); } catch { /* attribution is best-effort */ }
    let result: unknown;
    try {
      result = await handler(event as IpcMainInvokeEvent, ...(args as T));
    } finally {
      if (observer) {
        try { observer.end(begin, (event as IpcMainInvokeEvent | undefined)?.sender?.id, Date.now() - startedAt); } catch { /* best-effort */ }
      }
    }
    if (isWrite) {
      broadcastEvent("db:changed", null);
    }
    return result;
  };
  handlers.set(channel, wrappedHandler);
  ipcMain.handle(channel, wrappedHandler);
}

/**
 * Register a handler for a channel in the typed IPC contract
 * (`shared/ipc/contract.ts`): its arguments and result are checked against
 * the contract, which preload's `invokeContract` also uses. Channels whose
 * entry sets `writes: true` broadcast `db:changed` after they complete.
 */
export function registerContractHandle<C extends IpcChannel>(
  channel: C,
  handler: (event: IpcMainInvokeEvent, ...args: IpcArgs<C>) => Promise<IpcResult<IpcReturn<C>>>,
): void {
  registerIpcHandle<IpcArgs<C>>(channel, handler, IPC_WRITE_CHANNELS.has(channel));
}

/** Send a contract push event to one renderer, payload checked against `IpcEvents`. */
export function sendIpcEvent<E extends IpcEventChannel>(target: WebContents, channel: E, ...payload: IpcEventArgs<E>): void {
  target.send(channel, ...payload);
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
 * Retrieve a registered handler or listener by channel name for a remote
 * caller (the Mobile Access bridge). Only channels on the Mobile Access
 * allowlist (`mobile-access.ts`) are exposed; everything else is desktop-only.
 */
export function getIpcHandler(channel: string): IpcHandler | undefined {
  if (!isMobileChannel(channel)) return undefined;
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

/** {@link broadcastEvent} for a contract push event, payload checked against `IpcEvents`. */
export function broadcastIpcEvent<E extends IpcEventChannel>(channel: E, ...payload: IpcEventArgs<E>): void {
  broadcastEvent(channel, payload[0]);
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
