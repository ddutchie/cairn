/**
 * Cairn — IPC handlers for session persistence (`db:session:*`).
 *
 * The agent loop itself lives in `electron/ipc/session-runtime-handlers.ts` (streaming events
 * via `session:*`). These channels are the READ surface used by the
 * renderer's SessionPane to load coding-agent session history from the dsh
 * JSONL session log (session-as-truth) plus a small SQLite metadata layer
 * for the session index + todos.
 *
 * Extracted from the god-file `ipc/handlers.ts` (P2 of the cleanup plan).
 */

import { registerIpcHandle } from "./registry";
import { handle, type DbContext } from "./result-helpers";
import * as q from "../db/queries";
import { type ReplayMessage, type ReplaySubagent } from "../cordis/session-replay";
import { getAgentHost } from "../cordis/agent-host";

/** Map shared ReplayMessage[] to the coding-agent message shape the renderer expects. */
function toAgentMessages(messages: ReplayMessage[]) {
  return messages.map((m) => ({
    id: m.id,
    role: m.role as "user" | "assistant",
    content: m.content,
    reasoning: m.reasoning ?? null,
    toolCalls: (m.toolCalls && m.toolCalls.length
      ? m.toolCalls.map((tc) => ({ callId: tc.callId, name: tc.tool, label: tc.label, args: tc.args, output: tc.output, ok: tc.ok !== false, running: false }))
      : null),
    subagents: ((m as ReplayMessage & { subagents?: ReplaySubagent[] }).subagents ?? null),
    stats: m.stats ?? null,
    // ReplayMessage does not currently preserve event timestamps. Do not stamp
    // every historical message with "now"; the renderer will omit the label.
    timestamp: "",
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

export function registerSessionHandlers(ctx: DbContext): void {
  registerIpcHandle("db:session:list", (_e, { projectId }) => handle(() => q.getCodingSessions(ctx.db, projectId)));
  registerIpcHandle("db:session:create", (_e, args: Parameters<typeof q.createCodingSession>[1]) => handle(() => q.createCodingSession(ctx.db, args)));
  registerIpcHandle("db:session:delete", (_e, { id }) => handle(() => q.deleteCodingSession(ctx.db, id)));
  registerIpcHandle("db:session:todos", (_e, { sessionId }) => handle(() => q.getSessionTodos(ctx.db, sessionId)));

  // ── session:permissions ──────────────────────────────────────────────
  // On-demand permission-preset select for the renderer switcher (initial
  // mount; live changes arrive via session:projection kind:"permissions" from
  // permissions-bridge). Same {ok:true,value}|{ok:false,code,message} envelope
  // as subagent:* — unavailable while the presets service is inject-gated on
  // per-turn `shell` (the switcher hides until then). Writes go through the
  // existing cordis:executeCommand path (`/permission <preset>`), not here.
  registerIpcHandle("session:permissions", (_e, { sessionId }: { sessionId: string }) => handle(async () => {
    try {
      return { ok: true as const, value: await getAgentHost().readPermissionsSnapshot(sessionId) };
    } catch (err) {
      const code = (err as { code?: string })?.code ?? "internal";
      return { ok: false as const, code, message: err instanceof Error ? err.message : "permissions snapshot failed" };
    }
  }));

  // Session-as-truth load: rebuild the coding session's transcript from the dsh
  // JSONL session log (same source the agent resumes from) via the shared
  // session-replay helpers, matching the chat path. The coding agent's dsh session id
  // IS the raw sessionId (run-cordis-coding.ts:263 SessionId(sessionId)), so no
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
    if (!sessionId) return { messages: [] as ReturnType<typeof toAgentMessages> };
    try {
      const { messages, usage, contextRing, todos, stats } = await getAgentHost().loadSessionMessages(sessionId);
      const { enrichToolCallsWithMeta } = await import("../cordis/run-cordis-loop");
      const agentMessages = toAgentMessages(enrichToolCallsWithMeta(messages));
      return { messages: agentMessages, usage, contextRing, todos, stats };
    } catch (err) {
      if (isMissingSessionError(err)) {
        return { messages: [] as ReturnType<typeof toAgentMessages> };
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
