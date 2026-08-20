/**
 * Cairn — IPC handlers for Pi Agent session persistence (`db:piSession:*`).
 *
 * The agent loop itself lives in `electron/ipc/pi-agent.ts` (streaming events
 * via `pi-agent:*`). These channels are the SQLite read/write surface used by
 * the renderer's SessionPane to load and save session history.
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

export function registerPiSessionHandlers(ctx: DbContext): void {
  registerIpcHandle("db:piSession:list", (_e, { projectId }) => handle(() => q.getPiSessions(ctx.db, projectId)));
  registerIpcHandle("db:piSession:create", (_e, args: Parameters<typeof q.createPiSession>[1]) => handle(() => q.createPiSession(ctx.db, args)));
  registerIpcHandle("db:piSession:delete", (_e, { id }) => handle(() => q.deletePiSession(ctx.db, id)));
  registerIpcHandle("db:piSession:messages", (_e, { sessionId }) => handle(() => q.getPiMessages(ctx.db, sessionId)));
  registerIpcHandle("db:piSession:saveMessages", (_e, { sessionId, messages }) => handle(() => q.savePiMessages(ctx.db, sessionId, messages)));
  registerIpcHandle("db:piSession:todos", (_e, { sessionId }) => handle(() => q.getSessionTodos(ctx.db, sessionId)));

  // Session-as-truth load: rebuild the coding session's transcript from the dsh
  // JSONL session log (same source the agent resumes from) via the shared
  // session-replay helpers, matching the chat path. The pi-agent's dsh session id
  // IS the raw pi sessionId (run-cordis-coding.ts:263 SessionId(sessionId)), so no
  // prefix. Falls back to SQLite (pi_agent_messages) for sessions with no jsonl
  // (pre-dsh / built-in engine).
  registerIpcHandle("db:piSession:sessionMessages", (_e, { sessionId }: { sessionId: string }) => handle(async () => {
    if (!sessionId) return [] as ReturnType<typeof toPiMessages>;
    try {
      const { getContext } = await import("../cordis/run-cordis-loop");
      const cordisCtx = await getContext();
      const pers = (cordisCtx as unknown as { sessionPersistence?: Parameters<typeof loadSessionMessages>[0] }).sessionPersistence;
      if (!pers) return q.getPiMessages(ctx.db, sessionId);
      const liveSessions = (cordisCtx as unknown as { sessions?: { list: () => Array<{ id: unknown; header?: { origin?: string; parentSession?: unknown; createdAt?: number } }> } }).sessions?.list?.bind((cordisCtx as unknown as { sessions: unknown }).sessions);
      const { messages } = await loadSessionMessages(pers, liveSessions, sessionId);
      if (messages.length === 0) return q.getPiMessages(ctx.db, sessionId); // no jsonl → SQLite fallback
      return toPiMessages(messages);
    } catch {
      return q.getPiMessages(ctx.db, sessionId);
    }
  }));
}

