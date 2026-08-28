/**
 * Cairn — Chat session IPC (dsh as source of truth).
 *
 * Loads chat history directly from dsh's JSONL session log via the shared
 * session-replay helpers (electron/cordis/session-replay.ts), which use the
 * canonical surface (foldSurface + deriveEventMessage) and attach subagent
 * children. The coding-session load path uses the SAME helpers so both surfaces
 * stay in lockstep (session-as-truth, not the duplicated SQLite tables).
 */

import { registerIpcHandle } from "./registry";
import { handle, type DbContext } from "./result-helpers";
import { SessionId } from "@deepseek-ai/dsh-session";
import { loadSessionMessages, type ReplayMessage, type ReplaySubagent } from "../cordis/session-replay";
import type { ChatMessage } from "../../src/types";

function toChatMessages(threadId: string, messages: ReplayMessage[]): ChatMessage[] {
  return messages.map((m) => ({
    id: m.id,
    threadId,
    role: m.role,
    content: m.content,
    reasoning: m.reasoning,
    reasoningItems: m.reasoningItems,
    reasoningModel: m.reasoningModel,
    toolCalls: m.toolCalls && m.toolCalls.length ? m.toolCalls.map((tc) => ({ ...tc, status: "done" as const })) : undefined,
    subagents: (m as ReplayMessage & { subagents?: ReplaySubagent[] }).subagents,
    stats: m.stats,
    // ReplayMessage does not currently preserve event timestamps. Do not stamp
    // every historical message with "now"; the renderer will omit the label.
    createdAt: "",
  } as ChatMessage));
}

export function registerChatSessionHandlers(ctxDb: DbContext): void {
  registerIpcHandle("db:chat:sessionMessages", (_e, { threadId }: { threadId: string }) => handle(async () => {
    if (!threadId) return { messages: [] as ChatMessage[] };
    try {
      const { getContext, prepareReplayContext } = await import("../cordis/run-cordis-loop");
      const ctx = await getContext();
      const pers = (ctx as unknown as { sessionPersistence?: Parameters<typeof loadSessionMessages>[0] }).sessionPersistence;
      if (!pers) return { messages: [] as ChatMessage[] };

      // Plugin toolviews register through inject-gated backends that wait for
      // the fs chain (only mounted by chat turns) — mount + settle so the
      // tools registry can serve presentationMeta for enrichment below.
      const stableId = String(SessionId(`chat-${threadId}`));
      await prepareReplayContext(pers as { inspect: (id: string) => Promise<{ header?: { cwd?: string } }> }, stableId);
      const liveSessions = (ctx as unknown as { sessions?: { list: () => Array<{ id: unknown; header?: { origin?: string; parentSession?: unknown; createdAt?: number } }> } }).sessions?.list?.bind((ctx as unknown as { sessions: unknown }).sessions);
      const { messages, usage, contextRing, todos, stats, title } = await loadSessionMessages(pers, liveSessions, stableId);
      const { enrichToolCallsWithMeta } = await import("../cordis/run-cordis-loop");
      const chatMessages = toChatMessages(threadId, enrichToolCallsWithMeta(messages));

      return {
        messages: chatMessages,
        usage,
        contextRing,
        todos,
        stats,
        title: title ?? null,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("not found") || msg.includes("no such") || msg.includes("ENOENT") || msg.includes("but this backend is configured for compression") || msg.includes("encodingMismatch")) return { messages: [] as ChatMessage[] };
      throw err;
    }
  }));

  // ── Session title (chat-only, phase 1) ───────────────────────────────────
  // Direct read of the latest folded title for one chat thread (session:projection
  // is the live push path; this is the cold read / reload path).
  registerIpcHandle("session:title", (_e, { threadId, sessionId }: { threadId?: string; sessionId?: string }) => handle(async () => {
    const sid = sessionId ?? (threadId ? String(SessionId(`chat-${threadId}`)) : "");
    if (!sid || !sid.startsWith("chat-")) return { title: null as string | null };
    try {
      const { getContext } = await import("../cordis/run-cordis-loop");
      const ctx = await getContext();
      // Prefer projection read when available (already folded), else service get.
      const sess = (ctx as unknown as { sessions?: { get: (id: unknown) => unknown } }).sessions?.get?.(sid as never) as { events?: readonly unknown[] } | undefined;
      if (sess?.events) {
        const { foldSessionTitle } = await import("@deepseek-ai/dsh-session-title");
        const snap = foldSessionTitle(sess.events as never);
        if (snap) return { title: snap.title as string };
      }
      // Fallback to projection stateOf
      const registry = (ctx as unknown as { sessionProjections?: { stateOf: (s: unknown, k: string) => unknown } }).sessionProjections;
      if (sess && registry) {
        const v = registry.stateOf(sess as never, "title" as never) as string | null | undefined;
        if (v) return { title: v };
      }
      // Durable replay fallback (inspect)
      const pers = (ctx as unknown as { sessionPersistence?: { inspect: (id: unknown) => Promise<{ events: readonly unknown[] }> } }).sessionPersistence;
      if (pers) {
        try {
          const insp = await pers.inspect(sid);
          const { foldSessionTitle } = await import("@deepseek-ai/dsh-session-title");
          const snap = foldSessionTitle(insp.events as never);
          if (snap) return { title: snap.title as string };
        } catch { /* ignore */ }
      }
      return { title: null as string | null };
    } catch {
      return { title: null as string | null };
    }
  }));

  // Manual rename — pins the title (kind:'user'). Chat-only.
  registerIpcHandle("session:renameTitle", (_e, { threadId, sessionId, title }: { threadId?: string; sessionId?: string; title: string }) => handle(async () => {
    const sid = sessionId ?? (threadId ? String(SessionId(`chat-${threadId}`)) : "");
    if (!sid || !sid.startsWith("chat-")) throw new Error("renameTitle: only chat threads can be renamed");
    if (typeof title !== "string" || !title.trim()) throw new Error("renameTitle: title must be non-empty");
    const { getContext } = await import("../cordis/run-cordis-loop");
    const ctx = await getContext();
    const sess = (ctx as unknown as { sessions?: { get: (id: unknown) => unknown } }).sessions?.get?.(sid as never);
    // If session not yet live, open it (creates persistence header) then rename.
    let live = sess as { id: unknown } | undefined;
    if (!live) {
      const { openCordisSessionAgent } = await import("../cordis/session-agent");
      // Use workspacePath from caller? The handler doesn't have workspace context;
      // fall back to sessionRoot parent. For rename, cwd doesn't matter.
      const { getSessionRoot } = await import("../cordis/cordis-context");
      const cwd = getSessionRoot().replace(/\/sessions\/?$/, "") || process.cwd();
      // Ensure adapter is ready for the session (uses default model; title rename
      // itself doesn't need an LLM adapter, but session creation does).
      try {
        const { getCachedConfig } = await import("../lib/config-cache");
        const cached = getCachedConfig();
        const cfg = cached.agentConfig ?? {};
        const { ensureAgentAiAdapter } = await import("../cordis/session-runtime");
        if (cfg.baseUrl && cfg.model) {
          await ensureAgentAiAdapter(ctx, { baseUrl: cfg.baseUrl, model: cfg.model, apiKey: (cfg as { apiKey?: string }).apiKey ?? "", api: "openai-completions" as const });
        }
        const handle = await openCordisSessionAgent(ctx, { sessionId: sid, cwd, llmConfig: { baseUrl: cfg.baseUrl ?? "", model: cfg.model ?? "gpt-5.6-luna", apiKey: (cfg as { apiKey?: string }).apiKey ?? "", provider: "openai" }, createIfMissing: true });
        live = (handle as { agent?: { session?: unknown } }).agent?.session as { id: unknown } | undefined ?? ctx.sessions.get(sid as never) as { id: unknown } | undefined;
        // Dispose the temporary handle — we only needed the session, not a retained agent.
        try { await (handle as { dispose?: () => Promise<void> }).dispose?.(); } catch { /* ignore */ }
      } catch {
        // fall through to error below
      }
    }
    if (!live) throw new Error(`session "${sid}" is not live`);
    const svc = (ctx as unknown as { sessionTitle?: { rename: (s: unknown, t: string) => { title: string } } }).sessionTitle;
    if (!svc?.rename) throw new Error("sessionTitle service not mounted");
    const snap = svc.rename(live as never, title);
    // Also update the SQLite index row so the title survives even if the
    // session log is later pruned and for listing without a log read.
    try {
      const q = await import("../db/queries");
      const db = ctxDb.db;
      const targetId = threadId ?? sid.replace(/^chat-/, "");
      // Direct lookup by id (workspace-agnostic) — getChatThreads filters by
      // workspaceId, so we query SQLite directly to preserve workspace.
      const row = db.prepare("SELECT workspace_id, scope, project_id FROM chat_threads WHERE id = ?").get(targetId) as
        | { workspace_id: string; scope: string; project_id: string | null }
        | undefined;
      const wsId = row?.workspace_id ?? "";
      const scope = row?.scope ?? "workspace";
      const pid = row?.project_id ?? undefined;
      if (wsId) q.upsertChatThread(db, { id: targetId, scope, workspaceId: wsId, projectId: pid ?? undefined, title: snap.title });
      else {
        // No SQLite row yet (e.g. brand-new thread whose first turn hasn't
        // upserted the index). Still broadcast — the DB row will be created
        // on next chat message; projection is truth until then.
      }
    } catch { /* SQLite update is best-effort; projection is truth */ }
    return { title: snap.title as string };
  }));
}
