/**
 * Session guards — one home for every `session:*` refusal.
 *
 * Replaces ~15 hand-written `session:projection` + `session:busy` pairs that
 * were copied across `ipc/session-runtime-handlers.ts` (7 invalid-id, 6
 * already-running) and `ipc/engine-bridge.ts` (2 already-running).
 *
 * Turn-end rule — decided HERE, nowhere else:
 * - `rejectPrompt` ENDS the turn: it also emits `session:event` with
 *   `failedTurnEnd`. The renderer shows a spinner for the prompt and clears
 *   it only on `turn/end`, so a refusal that consumed the prompt must end it.
 * - `rejectInvalidId` / `rejectBusy` do NOT end the turn: they emit only the
 *   `session:projection` error plus `session:busy`. Busy means another turn is
 *   live and will send its own `turn/end`; invalid-id never started one.
 *
 * Payload shapes are pinned by `electron/ipc/session-guards.test.ts` — the
 * renderer keys off `projection.data.code` / `busy.reason`, and the busy
 * payload carries `message` ONLY for `rejectPrompt`.
 */

import type { IpcMainEvent } from "electron";
import { assertSafeId } from "./path-safety";
import { broadcastEvent, registerIpcOn } from "./registry";
import { failedTurnEnd } from "../agent/session/adapter";
import { makeSessionProjection, type SessionBusyReason } from "../../shared/agent/session-projection";

/** Refuse a renderer-supplied id that fails `assertSafeId`. No turn/end. */
export function rejectInvalidId(raw: unknown): string {
  const sessionId = String((raw as string | null | undefined) ?? "unknown");
  broadcastEvent("session:projection", makeSessionProjection(sessionId, "error", { message: "Invalid session id.", code: "invalid-id" }));
  broadcastEvent("session:busy", { sessionId, reason: "invalid-id" });
  return sessionId;
}

/**
 * Refuse work on a session that is already running (or clearing). No turn/end —
 * the live turn sends its own. `message` varies per call site; `code` stays
 * `already-running` so the renderer matches on one value.
 *
 * When `tap` is present (headless automation runs) the projection goes to the
 * tap instead of the renderer, but `session:busy` still broadcasts — this is
 * the `reportPromptError` busy path in `engine-bridge.ts`.
 */
export function rejectBusy(
  sessionId: string,
  message = "Session is busy — already running.",
  code: SessionBusyReason = "already-running",
  tap?: (channel: string, payload: unknown) => void,
): void {
  const projection = makeSessionProjection(sessionId, "error", { message, code });
  if (tap) tap("session:projection", projection);
  else broadcastEvent("session:projection", projection);
  broadcastEvent("session:busy", { sessionId, reason: code });
}

/**
 * Refuse a prompt before its turn starts. Ends the turn it never ran
 * (`session:event` with `failedTurnEnd`) so the renderer's spinner clears.
 */
export function rejectPrompt(sessionId: string, message: string, code: SessionBusyReason): void {
  broadcastEvent("session:projection", makeSessionProjection(sessionId, "error", { message, code }));
  broadcastEvent("session:busy", { sessionId, reason: code, message });
  broadcastEvent("session:event", { sessionId, event: failedTurnEnd(message) });
}

/**
 * Register a `session:*` listener that validates `req.sessionId` once and
 * passes the narrowed request to `handler`. Invalid ids are refused with the
 * standard invalid-id pair and the handler never runs.
 */
export function onSession<Req extends { sessionId?: unknown }>(
  channel: string,
  handler: (event: IpcMainEvent, req: Req & { sessionId: string }) => unknown,
): void {
  registerIpcOn(channel, (event, req: Req) => {
    try {
      assertSafeId((req as Req)?.sessionId, "sessionId");
    } catch {
      rejectInvalidId((req as unknown as { sessionId?: unknown })?.sessionId);
      return;
    }
    return handler(event, req as Req & { sessionId: string });
  });
}
