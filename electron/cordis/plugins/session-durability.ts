/**
 * cairn:session-durability — crash-durability checkpoints.
 *
 * Option (b) from Decision Doc B: targeted flush before top-level tool
 * dispatch + turn-end. Cairn previously called flush NOWHERE, relying solely
 * on the JSONL backend's 200ms write-behind timer (DEFAULT_WRITE_BATCH_MAX_DELAY_MS).
 * Retained chat agents skip the disposal-flush safety net between turns, so an
 * untimely crash could lose both a recorded tool call (before its side effect
 * executed) and the final batch of a turn.
 *
 * - Pre-tool:  tools/execute where exec.parent === undefined (top-level only).
 *              Await ctx.sessions.flush(exec.agent.session) before the tool body
 *              runs, so the durable log already contains the tool/call before any
 *              external mutation. Fail-closed on abort after the flush.
 * - Post-turn: callers (session-turn.ts, chat-session-runner.ts) invoke
 *              flushSession(...) after whenIdle settles. The plugin also exports
 *              that helper for explicit call sites.
 *
 * All flushes are best-effort and never throw to the caller: missing session,
 * absent ctx.sessions (tests), or backend rejections are swallowed. Nested
 * subagent calls (exec.parent !== undefined) reuse the durable outer call and
 * are not flushed.
 */

import type { Context } from "@deepseek-ai/cordis";
import type { Session } from "@deepseek-ai/dsh-session";

const TOOL_ABORTED_BEFORE_DISPATCH = "ABORTED_BEFORE_DISPATCH" as const;

/** Plugin mount — global, idempotent. */
export function mountSessionDurability(ctx: Context): void {
  (ctx as unknown as { on: (ev: string, fn: (...args: unknown[]) => unknown) => () => void }).on(
    "tools/execute",
    async (...args: unknown[]) => {
      const exec = args[0] as { agent?: { session?: Session }; parent?: unknown; signal?: AbortSignal } | undefined;
      const next = args[1] as (() => Promise<unknown>) | undefined;
      if (!exec || exec.agent === undefined || exec.parent !== undefined) return next ? next() : undefined;
      const session = exec.agent.session as Session | undefined;
      if (session) {
        try {
          const sessions = (ctx as unknown as { sessions?: { flush: (s: Session) => Promise<boolean> } }).sessions;
          if (sessions?.flush) await sessions.flush(session);
        } catch {
          // best-effort: disk, encoding, or shutdown errors must not break dispatch
        }
      }
      if (exec.signal?.aborted) {
        return {
          isError: true,
          content: [{ type: "text", text: "Error: tool call aborted before dispatch" }],
          error: { message: "tool call aborted before dispatch", info: { name: "AbortError", code: TOOL_ABORTED_BEFORE_DISPATCH } },
        } as unknown as Awaited<ReturnType<NonNullable<typeof next>>>;
      }
      return next ? next() : undefined;
    },
  );
}

/** Best-effort flush for explicit turn-end sites (session-turn, chat runner). */
export async function flushSession(ctx: Context, session: unknown): Promise<void> {
  if (!session || typeof session !== "object") return;
  try {
    const sessions = (ctx as unknown as { sessions?: { flush: (s: unknown) => Promise<boolean> } }).sessions;
    if (!sessions?.flush) return;
    await sessions.flush(session as Session);
  } catch {
    // best-effort — missing session, torn log, or shutdown must not throw at turn boundary
  }
}
