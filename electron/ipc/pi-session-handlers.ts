/**
 * Cairn — IPC handlers for session persistence (`db:session:*`).
 *
 * The agent loop itself lives in `electron/ipc/pi-agent.ts` (streaming events
 * via `pi-agent:*`). These channels are the READ surface used by the
 * renderer's SessionPane to load coding-agent session history from the dsh
 * JSONL session log (session-as-truth) plus a small SQLite metadata layer
 * for the session index + todos.
 *
 * Extracted from the god-file `ipc/handlers.ts` (P2 of the cleanup plan).
 */

import { registerIpcHandle } from "./registry";
import { handle, type DbContext } from "./result-helpers";
import * as q from "../db/queries";
import { loadSessionMessages, type ReplayMessage, type ReplaySubagent } from "../cordis/session-replay";

/** Map shared ReplayMessage[] → the pi-agent message shape the renderer expects. */
function toPiMessages(messages: ReplayMessage[]) {
  return messages.map((m) => ({
    id: m.id,
    role: m.role as "user" | "assistant",
    content: m.content,
    reasoning: m.reasoning ?? null,
    toolCalls: (m.toolCalls && m.toolCalls.length
      ? m.toolCalls.map((tc) => ({ callId: tc.callId, name: tc.tool, label: tc.label, args: tc.args, output: tc.output, ok: tc.ok !== false, running: false }))
      : null),
    subagents: ((m as ReplayMessage & { subagents?: ReplaySubagent[] }).subagents ?? null),
    timestamp: new Date().toISOString(),
  }));
}

/**
 * Loose match for "this session doesn't exist on disk" errors from
 * dsh-session-persistence-jsonl / node's fs layer. We swallow those and
 * return an empty transcript (new session, clean state). Anything else
 * — a version-format bump, a permission error, a corrupt file — is a
 * SIGNAL, not silence, and gets rethrown so the renderer can show it.
 */
function isMissingSessionError(err: unknown): boolean {
  const e = err as { code?: string; message?: string; name?: string };
  if (!e) return false;
  if (e.code === "ENOENT") return true;
  const msg = String(e.message ?? "");
  return /not found|does not exist|no such session/i.test(msg);
}

export function registerPiSessionHandlers(ctx: DbContext): void {
  registerIpcHandle("db:session:list", (_e, { projectId }) => handle(() => q.getPiSessions(ctx.db, projectId)));
  registerIpcHandle("db:session:create", (_e, args: Parameters<typeof q.createPiSession>[1]) => handle(() => q.createPiSession(ctx.db, args)));
  registerIpcHandle("db:session:delete", (_e, { id }) => handle(() => q.deletePiSession(ctx.db, id)));
  registerIpcHandle("db:session:todos", (_e, { sessionId }) => handle(() => q.getSessionTodos(ctx.db, sessionId)));

  // Session-as-truth load: rebuild the coding session's transcript from the dsh
  // JSONL session log (same source the agent resumes from) via the shared
  // session-replay helpers, matching the chat path. The pi-agent's dsh session id
  // IS the raw pi sessionId (run-cordis-coding.ts:263 SessionId(sessionId)), so no
  // prefix.
  //
  // Error policy: we ONLY swallow "session not found" (a genuine new/blank
  // session). Corruption, permission errors, a dsh SESSION_FORMAT_VERSION
  // bump (SessionFormatUnsupportedError from
  // dsh-session-persistence-jsonl:184), or any other unexpected error is
  // rethrown so the renderer can surface it — an empty transcript is
  // indistinguishable from data loss, and hiding a version mismatch on a
  // silent upgrade would strand every pre-bump session with no diagnostic.
  registerIpcHandle("db:session:messages", (_e, { sessionId }: { sessionId: string }) => handle(async () => {
    if (!sessionId) return { messages: [] as ReturnType<typeof toPiMessages> };
    try {
      const { getContext, prepareReplayContext } = await import("../cordis/run-cordis-loop");
      const cordisCtx = await getContext();
      const pers = (cordisCtx as unknown as { sessionPersistence?: Parameters<typeof loadSessionMessages>[0] }).sessionPersistence;
      if (!pers) return { messages: [] as ReturnType<typeof toPiMessages> };
      // Mount the fs chain + settle the loader so plugin toolviews are
      // registered before presentationMeta recomputation (see chat-session).
      await prepareReplayContext(pers as { inspect: (id: string) => Promise<{ header?: { cwd?: string } }> }, sessionId);
      const liveSessions = (cordisCtx as unknown as { sessions?: { list: () => Array<{ id: unknown; header?: { origin?: string; parentSession?: unknown; createdAt?: number } }> } }).sessions?.list?.bind((cordisCtx as unknown as { sessions: unknown }).sessions);
      const { messages, usage, contextRing, todos } = await loadSessionMessages(pers, liveSessions, sessionId);
      const { enrichToolCallsWithMeta } = await import("../cordis/run-cordis-loop");
      const piMessages = toPiMessages(enrichToolCallsWithMeta(messages));
      return { messages: piMessages, usage, contextRing, todos };
    } catch (err) {
      if (isMissingSessionError(err)) {
        return { messages: [] as ReturnType<typeof toPiMessages> };
      }
      // Attach a useful diagnostic prefix so the renderer's error toast is
      // actionable (users have historically opened issues with the raw
      // "Cannot read properties of undefined" and no clue what session or
      // path failed).
      const e = err as { message?: string; name?: string };
      const prefix = e?.name === "SessionFormatUnsupportedError"
        ? `Session '${sessionId}' was recorded on a newer runtime version and cannot be read by this build`
        : `Failed to load session '${sessionId}'`;
      throw new Error(`${prefix}: ${e?.message ?? String(err)}`);
    }
  }));
}

