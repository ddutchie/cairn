/**
 * The singleton engine host and session lifecycle. (F5/B4: split out of
 * `electron/ipc/engine-bridge.ts`; no logic changes.)
 */
import type { DbContext } from "../result-helpers";
import { broadcastEvent } from "../registry";
import { AgentHost } from "../../agent/host";
import { JobRegistry } from "../../agent/jobs";
import { LspManager } from "../../agent/lsp";
import { sharedPtyAdapter, TerminalRegistry } from "../../agent/terminals";
import { presetRules } from "../../agent/rules";
import { createHostStore, recordUsage } from "../../agent/host-store";
import { deleteSessionProfile } from "../../db/workspace-queries";
import { deleteSessionEmbeddings } from "../../db/embeddings-queries";
import { getWorkspaceApprovalGrants } from "../../db/approval-grant-queries";
import { addWorkspaceApprovalGrant } from "../../db/approval-grant-queries";
import { notifyAgentAttention } from "../../lib/agent-attention";
import { makeSessionProjection } from "../../../shared/agent/session-projection";
import { grantsToRules } from "./permissions";
import { adoptLegacySession, hostRoot, removeLegacySessions } from "./legacy-sessions";
import {
  sessionPlanning,
  sessionRules,
  sessionTaps,
  sessionWorkspace,
  spawnContexts,
  usageMeta,
} from "./session-state";

let host: AgentHost | undefined;
let hostCtx: DbContext | undefined;

let jobRegistry: JobRegistry | undefined;
/** Background jobs for the whole process; changes reach the jobs dock, endings reach the model. */
export function getJobRegistry(): JobRegistry {
  jobRegistry ??= new JobRegistry({
    changed: (owner) => broadcastEvent("session:projection", makeSessionProjection(owner, "jobs", { ownerSession: owner, jobs: jobRegistry!.list(owner) })),
    settled: (job, tail) => {
      if (!job.ownerSession) return;
      host?.notify(job.ownerSession, `Background job ${job.id} (${job.label}) ${job.status}${job.detail ? `: ${job.detail}` : ""}.${tail ? ` Last output:\n${tail}` : ""}`);
    },
  });
  return jobRegistry;
}

let lspManager: LspManager | undefined;
export const getLsp = (): LspManager => (lspManager ??= new LspManager());

let terminalRegistry: TerminalRegistry | undefined;
export function getTerminals(ctx: DbContext): TerminalRegistry {
  terminalRegistry ??= new TerminalRegistry(() => sharedPtyAdapter(ctx.db));
  return terminalRegistry;
}

/** Release a session's live turn without dropping its remembered state. */
export function releaseEngineSession(sessionId: string): void {
  host?.release(sessionId);
}

export function getEngineHost(ctx: DbContext): AgentHost {
  hostCtx = ctx;
  host ??= new AgentHost({
    root: hostRoot(),
    beforeOpen: adoptLegacySession,
    readNote: (noteId) => createHostStore(ctx.db).readNoteContent(noteId),
    send: (channel, payload) => {
      const sid = "sessionId" in payload ? String(payload.sessionId) : "";
      const tap = sessionTaps.get(sid);
      if (tap) tap(channel, payload); else broadcastEvent(channel, payload);
    },
    askTtlMs: undefined,
    globalRules: (sessionId) => {
      const base = [...presetRules("cairn-data", "safe-shell"), ...(sessionRules.get(sessionId) ?? [])];
      const workspaceId = sessionWorkspace.get(sessionId);
      if (!workspaceId || !hostCtx) return base;
      try { return [...base, ...grantsToRules(sessionId, getWorkspaceApprovalGrants(hostCtx.db, workspaceId))]; } catch { return base; }
    },
    onWorkspaceGrant: (sessionId, rule) => {
      const workspaceId = sessionWorkspace.get(sessionId);
      if (!workspaceId || !hostCtx) return;
      // Only the tool and a command are stored, so a grant for a folder outside the workspace would
      // come back as a grant for the whole workspace. It stays a grant for this session.
      if (rule.match.path && rule.match.path.within !== "workspace") return;
      addWorkspaceApprovalGrant(hostCtx.db, workspaceId, rule.match.tool ?? "", rule.match.command?.exact ?? null);
    },
    onAssistantMessage: (sessionId, message) => {
      const meta = usageMeta.get(sessionId);
      const u = message.usage;
      if (!meta || !u) return;
      const promptTokens = u.input + u.cacheRead + u.cacheWrite;
      if (promptTokens === 0 && u.output === 0) return;
      // Cost is left unset: the usage recorder prices tokens itself.
      recordUsage({
        source: meta.source, sessionId, projectId: meta.projectId, workspaceId: meta.workspaceId,
        provider: meta.provider, model: meta.model, baseUrl: meta.baseUrl,
        promptTokens, completionTokens: u.output, reasoningTokens: u.reasoning ?? 0,
        cacheReadTokens: u.cacheRead, cacheCreationTokens: u.cacheWrite,
      } as never);
    },
    onAsk: (ask) => {
      // A tapped run (an automation) answers or reports its own asks; it has no session to open.
      if (sessionTaps.has(ask.sessionId)) return;
      if (hostCtx) notifyAgentAttention(hostCtx.db, { sessionId: ask.sessionId, kind: "approval", detail: ask.title });
    },
  });
  return host;
}

/** True when the engine owns this session (it has a live run or a native log). */
export async function engineOwns(ctx: DbContext, sessionId: string): Promise<boolean> {
  const h = getEngineHost(ctx);
  if (h.isRunning(sessionId)) return true;
  const has = async (): Promise<boolean> => (await h.title(sessionId).catch(() => null)) !== null || (await h.loadMessages(sessionId).then((m) => m.messages.length > 0, () => false));
  if (await has()) return true;
  await adoptLegacySession(sessionId);
  return has();
}

/** Drop what a closed or cleared session left in memory. */
export function forgetEngineSession(sessionId: string): void {
  jobRegistry?.killAll(sessionId);
  terminalRegistry?.closeAll(sessionId);
  sessionPlanning.delete(sessionId);
  for (const id of [...spawnContexts.keys()]) if (id === sessionId || id.startsWith(`${sessionId}.sub-`)) spawnContexts.delete(id);
}

/** The retired harness kept per-turn copies as `<session>-<epoch ms>-<suffix>`. */
const LEGACY_TURN_COPY = /^-\d{10,}-[a-z0-9]+$/;

/**
 * Delete a session for good: its log and its subagents', the retired harness's copy (which would
 * otherwise be re-imported on the next touch), its profile and its search vectors. Without this a
 * deleted session stayed on disk and searchable from memory.
 * `aliases` are other names the legacy copy may go by (a chat's thread id).
 * Throws when the log or the legacy copy can't be removed, before the profile and vectors go, so the
 * caller can keep its own record and the delete can be retried.
 */
export async function destroyEngineSession(ctx: DbContext, sessionId: string, aliases: string[] = []): Promise<void> {
  forgetEngineSession(sessionId);
  await getEngineHost(ctx).destroy(sessionId);
  const names = [sessionId, ...aliases];
  // Only exact names and per-turn copies: another session's id may also start with `<id>-`.
  removeLegacySessions((name) => names.some((n) => name === n || (name.startsWith(n) && LEGACY_TURN_COPY.test(name.slice(n.length)))), { strict: true });
  deleteSessionProfile(ctx.db, sessionId);
  deleteSessionEmbeddings(ctx.db, sessionId);
}

/** Quit: stop running turns, their jobs and terminals, and any language servers. */
export async function shutdownEngine(): Promise<void> {
  for (const id of host?.runningIds() ?? []) { host?.abort(id); forgetEngineSession(id); }
  // Jobs and terminals outlive their turn, so idle sessions' ones must be stopped too.
  jobRegistry?.killEvery();
  terminalRegistry?.closeEvery();
  lspManager?.disposeAll();
  await import("../../lib/mcp-client").then((m) => m.disposeAll()).catch(() => undefined);
}
