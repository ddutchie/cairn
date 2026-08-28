/**
 * cairn:session-title — bridge from dsh's log-backed session-title service
 * to the renderer via the projection + live cache pattern (mirrors context-ring).
 *
 * The service (`ctx.sessionTitle`) holds the authoritative fold:
 *   - `foldSessionTitle(events)` is the pure replay-safe fold over the log;
 *   - `ctx.sessionTitle.get(session)` is the live fold;
 *   - the projection key `title` (string | null) is the client-visible view.
 *
 * This module keeps a live snapshot per chat session (chat-* only, phase 1)
 * and broadcasts title changes on `session:projection` with kind `title`
 * so thread rows can auto-title without polling. It also exposes
 * `cachedSessionTitle(sessionId)` for direct IPC reads (e.g. initial load).
 *
 * Chat-only: only sessions whose id starts with `chat-` are tracked/broadcast.
 * Coding sessions are ignored in phase 1 (defer).
 */

import type { Context } from "@deepseek-ai/cordis";
import { foldSessionTitle } from "@deepseek-ai/dsh-session-title";

// Live snapshot cache — survives agent disposal between turns.
const titleCache = new Map<string, string | null>();

export const SESSION_TITLE_PROJECTION_KEY = "title";

export function cachedSessionTitle(sessionId: string): string | null | undefined {
  return titleCache.get(sessionId);
}

/** Pure re-export for callers that want to fold without a live ctx. */
export { foldSessionTitle };

/** Register projection bridging and keep live cache warm. */
export function mountSessionTitleBridge(ctx: Context): void {
  // Keep cache in sync on every committed event (covers fallback, provider,
  // and manual rename). Filter to chat-* in phase 1.
  (ctx as unknown as { on: (ev: string, fn: (session: unknown, event: unknown) => void) => () => void }).on(
    "session/event",
    (session: unknown) => {
      try {
        const id = String((session as { id?: unknown }).id ?? "");
        if (!id || !id.startsWith("chat-")) return;
        // Prefer projection read (string | null) when available, else service get.
        const registry = (ctx as unknown as { sessionProjections?: { stateOf: (s: unknown, key: string) => unknown } }).sessionProjections;
        let title: string | null | undefined;
        if (registry) {
          title = registry.stateOf(session as never, SESSION_TITLE_PROJECTION_KEY as never) as string | null | undefined;
        }
        if (title === undefined) {
          const svc = (ctx as unknown as { sessionTitle?: { get: (s: unknown) => { title?: string } | undefined } }).sessionTitle;
          const snap = svc?.get(session as never);
          title = snap?.title ?? null;
        }
        // Cache current value (null = before first title)
        titleCache.set(id, title ?? null);

        // Broadcast on session:projection for live thread-row updates.
        // Use shared projection helper if available; fall back to raw broadcast.
        if (title !== undefined) {
          try {
            const { broadcastEvent } = require("../../ipc/registry") as { broadcastEvent: (ch: string, payload: unknown) => void };
            // Lazy import to avoid circular init order
            const { makeSessionProjection } = require("../../../shared/agent/session-projection") as {
              makeSessionProjection: (sid: string, kind: string, data: unknown) => unknown;
            };
            const proj = makeSessionProjection(id, "title" as unknown as string, { title: title ?? null } as unknown as never);
            broadcastEvent("session:projection", proj);
          } catch {
            // bridge is decoration — never break the stream
          }
        }
      } catch {
        /* badge is decoration — never break the stream */
      }
    },
  );

  // Also watch projection change feed directly — captures cases where
  // session/event listener's registry.read races the drive watermark update.
  try {
    const registry = (ctx as unknown as { sessionProjections?: { onChanged: (l: (s: unknown, k: string, v: unknown, seq: number) => void) => () => void } }).sessionProjections;
    registry?.onChanged((session: unknown, key: string, value: unknown) => {
      if (key !== SESSION_TITLE_PROJECTION_KEY) return;
      const id = String((session as { id?: unknown }).id ?? "");
      if (!id || !id.startsWith("chat-")) return;
      const title = (value as string | null) ?? null;
      titleCache.set(id, title);
      try {
        const { broadcastEvent } = require("../../ipc/registry") as { broadcastEvent: (ch: string, payload: unknown) => void };
        const { makeSessionProjection } = require("../../../shared/agent/session-projection") as {
          makeSessionProjection: (sid: string, kind: string, data: unknown) => unknown;
        };
        const proj = makeSessionProjection(id, "title" as unknown as string, { title } as unknown as never);
        broadcastEvent("session:projection", proj);
      } catch {
        /* ignore */
      }
    });
  } catch {
    /* ignore */
  }
}

/**
 * Fold a raw event log to the latest title (chat-only helper).
 * Returns the title string or null before first eligible title.
 */
export function foldTitleFromEvents(events: readonly { type: string; data?: unknown }[]): string | null {
  // Reuse the upstream fold — it returns a snapshot or undefined.
  const snap = foldSessionTitle(events as unknown as Parameters<typeof foldSessionTitle>[0]);
  return snap?.title ?? null;
}
