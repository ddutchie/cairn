/**
 * Cairn — IPC handlers for session persistence (`db:session:*`).
 *
 * The agent loop itself lives in `electron/ipc/session-runtime-handlers.ts` (streaming events
 * via `session:*`). These channels are the READ surface used by the
 * renderer's SessionPane to load coding-agent session history from the engine
 * JSONL session log (session-as-truth) plus a small SQLite metadata layer
 * for the session index + todos.
 *
 * Extracted from the god-file `ipc/handlers.ts` (P2 of the cleanup plan).
 */

import { registerContractHandle } from "./registry";
import { handle, type DbContext } from "./result-helpers";
import * as q from "../db/queries";
import type { ReplayMessage, ReplaySubagent } from "../../shared/agent/session-wire";
import { engineOwns, getEngineHost, readEnginePermissions, setEnginePermission } from "./engine-bridge";
import { getCachedConfig } from "../lib/config-cache";
import type { Mode } from "../../shared/agent/approval-mode";
import type { AgentSessionMessage } from "../../shared/agent/session-wire";

/** Map shared ReplayMessage[] to the coding-agent message shape the renderer expects. */
function toAgentMessages(messages: ReplayMessage[]): AgentSessionMessage[] {
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

export function registerSessionHandlers(ctx: DbContext): void {
  registerContractHandle("db:session:list", (_e, { projectId }) => handle(() => q.getCodingSessions(ctx.db, projectId)));
  registerContractHandle("db:session:create", (_e, args) => handle(() => q.createCodingSession(ctx.db, args)));
  registerContractHandle("db:session:delete", (_e, { id }) => handle(() => q.deleteCodingSession(ctx.db, id)));
  registerContractHandle("db:session:todos", (_e, { sessionId }) => handle(() => q.getSessionTodos(ctx.db, sessionId)));

  // ── session:permissions ──────────────────────────────────────────────
  // On-demand permission-preset select for the renderer switcher (initial
  // mount; live changes arrive via session:projection kind:"permissions" from
  // permissions-bridge). Same {ok:true,value}|{ok:false,code,message} envelope
  // as subagent:* — unavailable while the presets service is inject-gated on
  // per-turn `shell` (the switcher hides until then). Writes go through the
  // `/permission <preset>` command, not here.
  registerContractHandle("session:permissions", (_e, { sessionId }) => handle(async () => {
    try {
      return { ok: true as const, value: readEnginePermissions(sessionId, getCachedConfig().agentConfig?.mode as Mode | undefined) };
    } catch (err) {
      const code = (err as { code?: string })?.code ?? "internal";
      return { ok: false as const, code, message: err instanceof Error ? err.message : "permissions snapshot failed" };
    }
  }));

  // ── session:permissions:set ──────────────────────────────────────────
  // Preset switch for the renderer switcher; works while the session is idle.
  registerContractHandle("session:permissions:set", (_e, { sessionId, preset }) => handle(async () => {
    try {
      return { ok: true as const, value: setEnginePermission(sessionId, preset, getCachedConfig().agentConfig?.mode as Mode | undefined) };
    } catch (err) {
      const code = (err as { code?: string })?.code ?? "internal";
      return { ok: false as const, code, message: err instanceof Error ? err.message : "permission switch failed" };
    }
  }));

  // Session-as-truth load: rebuild the transcript from the engine's session log.
  registerContractHandle("db:session:messages", (_e, { sessionId }) => handle(async () => {
    if (!sessionId) return { messages: [] as AgentSessionMessage[] };
    // Sessions that live in the native engine replay from their own log.
    if (await engineOwns(ctx, sessionId)) {
      const { messages, usage, title, contextRing, todos } = await getEngineHost(ctx).loadMessages(sessionId);
      return { messages: toAgentMessages(messages), usage, title, contextRing, todos };
    }
    return { messages: [] as AgentSessionMessage[] };
  }));
}
