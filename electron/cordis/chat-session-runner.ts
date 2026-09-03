import { SessionId, type SessionEvent } from "@deepseek-ai/dsh-session";
import type { Database } from "better-sqlite3";
import { buildCordisUserContent } from "./cairn-attachment-store";
import { registerCairnTools, registerExternalCairnTools } from "./cairn-tools";
import { cairnSystemPromptPlugin, CAIRN_DB, cairnApprovalPlugin } from "./cairn-plugins";
import { cairnDoomLoopPlugin } from "./plugins/doom-loop";
import { getChatAgentCache } from "./chat-agent-cache";
import { extractCairnRef } from "./session-replay";
import { openCordisSessionAgent } from "./session-agent";
import { runCordisTurn, type CordisTurnAgent } from "./session-turn";
import { runCordisSession } from "./session-runner";
import { buildSystemPrompt, withPersonality, startPhaseTimer, createHostStore } from "./host-store";
import type { RunCordisLoopOptions, RunCordisLoopResult } from "./run-cordis-loop";
import { dropChatAgentForThread, getContext, resolvePresentationMeta } from "./cordis-context";
import { foldSessionUsage } from "./plugins/context-ring";
import { foldSessionStats } from "./session-stats";

type Collected = { text: string; reasoning: string; pt: number; ct: number; rt: number };

/**
 * Read a live session's events through the dsh 0.1.2-alpha.4+ on-demand API
 * (`snapshotEvents()`). `session.events` was removed upstream — kept as a
 * fallback for foreign session-likes in tests.
 */
function readSessionEvents(session: unknown): readonly SessionEvent[] {
  const s = session as {
    snapshotEvents?: () => readonly SessionEvent[];
    events?: readonly SessionEvent[];
  } | null | undefined;
  if (typeof s?.snapshotEvents === "function") return s.snapshotEvents();
  return s?.events ?? [];
}

// Opt-in turn-latency instrumentation. Set CAIRN_TIMING=1 to log per-phase
// timings for chat turns: getContext, prepareCordisRuntime (transport + adapter),
// plugin/tool setup, agent open (cache hit vs resume/replay), pre-followup idle
// wait, request/header count (>1 = a provider retry), time-to-first-token, and a
// warning when a Responses attempt yields nothing and the turn re-runs on
// completions. Zero-cost when the env var is unset. Useful for isolating whether
// a slow turn is Cairn assembly, agent settle, or upstream provider latency.
const TIMING = process.env.CAIRN_TIMING === "1" || process.env.CAIRN_TIMING === "true";
function markNow(): number { return TIMING ? Date.now() : 0; }
function markLog(label: string, since: number): void {
  if (TIMING) console.log(`[timing] ${label}: ${Date.now() - since}ms`);
}

function collect(events: readonly SessionEvent[], firstSeq: number): Collected {
  let text = "";
  let reasoning = "";
  let pt = 0;
  let ct = 0;
  let rt = 0;
  let started = false;
  for (const event of events) {
    if (event.seq < firstSeq) continue;
    if (event.type === "turn/start") { started = true; continue; }
    if (!started) continue;
    if (event.type === "assistant/chunk") {
      const chunk = (event.data as { chunk?: { type?: string; text?: string; usage?: { inputTokens?: number; outputTokens?: number; reasoningTokens?: number } } }).chunk;
      if (chunk?.type === "text-delta" && chunk.text) text += chunk.text;
      if (chunk?.type === "reasoning-delta" && chunk.text) reasoning += chunk.text;
      if (chunk?.type === "usage" && chunk.usage) {
        pt = Math.max(pt, chunk.usage.inputTokens ?? 0);
        ct += chunk.usage.outputTokens ?? 0;
        rt += chunk.usage.reasoningTokens ?? 0;
      }
    }
    if (event.type === "assistant/message" && !reasoning) {
      const content = (event.data as { message?: { content?: Array<{ type?: string; text?: string }> } }).message?.content;
      if (Array.isArray(content)) reasoning = content.filter((b) => b.type === "reasoning" && b.text).map((b) => b.text).join("");
    }
  }
  return { text, reasoning, pt, ct, rt };
}

function parseArgs(raw: string | undefined): Record<string, unknown> {
  try { return JSON.parse(raw ?? "{}") as Record<string, unknown>; } catch { return {}; }
}

/**
 * Emit a single synthetic `assistant/chunk` usage event carrying the full
 * server-computed token breakdown (foldSessionUsage over the entire event log),
 * so the renderer's live event fold persists a breakdown-bearing `lastUsage`.
 *
 * Without this, the only usage events in the stream come straight from the
 * provider with just {inputTokens, outputTokens} — no breakdown — so the
 * Context Ring falls back to `Tool outputs 0`. This mirrors precisely what the
 * reload path (loadSessionMessages → foldSessionUsage) already returns, keeping
 * the live and reloaded rings identical.
 */
function emitBreakdownUsage(events: readonly SessionEvent[], onSessionEvent?: (event: SessionEvent) => void): void {
  if (!onSessionEvent) return;
  try {
    const usage = foldSessionUsage(events);
    if (!usage?.breakdown) return;
    const synthetic = {
      type: "assistant/chunk",
      seq: -1,
      data: {
        chunk: {
          type: "usage",
          usage: {
            inputTokens: usage.promptTokens,
            outputTokens: usage.completionTokens,
            reasoningTokens: usage.reasoningTokens,
            cacheReadTokens: usage.cacheReadTokens,
            cacheCreationTokens: usage.cacheCreationTokens,
            costUsd: usage.costUsd,
            breakdown: usage.breakdown,
          },
        },
      },
    } as unknown as SessionEvent;
    onSessionEvent(synthetic);
  } catch { /* the ring is decoration — never break the turn over a breakdown */ }
}

/**
 * Emit a synthetic `assistant/chunk` stats event so the LIVE turn's per-message
 * throughput/latency (TTFT · tok/s · output tokens) shows immediately — the same
 * capture-at-stream-time approach as the Context Ring breakdown, instead of
 * waiting for a reload. foldSessionStats over the turn's events yields per-turn
 * metrics; we take the highest (latest) turn's reading and hand it to the
 * renderer, which attaches it to the assistant bubble at turn end.
 */
function emitTurnStats(events: readonly SessionEvent[], onSessionEvent?: (event: SessionEvent) => void): void {
  if (!onSessionEvent) return;
  try {
    const s = foldSessionStats(events);
    if (!s) return;
    const turns = Object.keys(s.byTurn).map(Number);
    if (turns.length === 0) return;
    const latest = s.byTurn[Math.max(...turns)];
    if (!latest) return;
    const synthetic = {
      type: "assistant/chunk",
      seq: -1,
      data: { chunk: { type: "stats", stats: latest } },
    } as unknown as SessionEvent;
    onSessionEvent(synthetic);
  } catch { /* stats are decoration — never break the turn */ }
}

/** Chat-specific profile over the shared Cordis session lifecycle. */
export async function runChatCordisSession(opts: RunCordisLoopOptions): Promise<RunCordisLoopResult> {
  const turnStart = markNow();
  // Always-on phase timing to the persistent debug log, in addition to the
  // opt-in CAIRN_TIMING console output. The console-only route was unusable for
  // diagnosing a report of a slow turn after the fact (packaged builds have no
  // terminal, and nothing was retained across restarts).
  const timer = startPhaseTimer("chat", { threadId: opts.req.threadId, model: opts.llmConfig.model });
  const ctx = await getContext();
  markLog("getContext", turnStart);
  timer.mark("getContext (cold: builds 26 Cordis plugins sequentially)");
  const { db, req, workspacePath, signal } = opts;
  let llmConfig = opts.llmConfig;

  // Runtime-loaded development plugins need one process-level fs chain.
  try {
    const { pluginsDevEnabled } = await import("./plugin-loader");
    if (pluginsDevEnabled() && !ctx.get("fs")) {
      const { mountFsChain } = await import("./cordis-coding-tools");
      await mountFsChain(ctx, { cwd: workspacePath });
    }
    const now = Date.now();
    const g = globalThis as unknown as { __cairnArtifactHygieneAt?: number };
    if (!g.__cairnArtifactHygieneAt || now - g.__cairnArtifactHygieneAt > 10 * 60 * 1000) {
      g.__cairnArtifactHygieneAt = now;
      try {
        createHostStore(db).runWorkspaceHygiene(workspacePath);
      } catch { /* best-effort hygiene */ }
    }
  } catch (error) {
    console.error("[cordis] fs chain mount for plugins failed:", error instanceof Error ? error.message : error);
  }
  // Runs synchronous fs walks over the workspace, throttled to once per 10 min —
  // so it is invisible on most turns and pays a one-off cost on others.
  timer.mark("plugin fs chain + artifact hygiene");

  const baseSystem = withPersonality(buildSystemPrompt(req), req.personality);
  const chatAgents = getChatAgentCache();
  let liveText = "";
  let liveReasoning = "";
  let currentAttemptSessionId: unknown = null;
  let firstTokenLogged = false;
  const logFirstToken = () => { if (TIMING && !firstTokenLogged) { firstTokenLogged = true; markLog("time-to-first-token (from turn entry)", turnStart); } };
  // The single most diagnostic pair of numbers for a slow turn, both measured
  // from turn entry: when the assembled request left Cairn (`request/header`)
  // and when the first token came back. A large gap between them is upstream
  // latency (provider/proxy/network) and NOT something Cairn's assembly causes —
  // without this split, all anyone can say is "the turn took 13 seconds".
  const wallStart = Date.now();
  let requestHeaderAtMs: number | undefined;
  let firstTokenAtMs: number | undefined;
  const noteFirstToken = () => {
    firstTokenAtMs ??= Date.now() - wallStart;
    logFirstToken();
  };
  // Per-turn request counter — each provider (re)attempt emits its own
  // request/header. >1 header before the first token means the pi-ai adapter's
  // retryPolicy is silently retrying (a stall we can tune), not pure provider
  // latency. Logged with the elapsed time so a slow turn shows the retry cadence.
  let requestHeaderCount = 0;

  const runAttempt = async (): Promise<Collected & { failedKind?: string }> => runCordisSession({
    ctx,
    db,
    req,
    sessionId: `chat-${req.threadId}`,
    profileId: "chat",
    cwd: workspacePath,
    workspaceId: req.workspaceId,
    projectId: req.projectId,
    llmConfig,
    signal,
    includeSessionIndex: true,
    sendSubagent: opts.sendSubagent,
      questions: opts.questions,
    onSessionEvent: (event) => opts.onSessionEvent?.(event),
    retainAgent: true,
    setup: async ({ llmConfig: preparedConfig, resources, mount }) => {
      llmConfig = preparedConfig;
      try {
        const host = createHostStore(db);
        const meta = host.getWorkspaceMeta(req.workspaceId, req.projectId);
        const { updateWorkspaceContext } = await import("./plugins/workspace-context");
        // Use the real workspacePath (the agent's sandbox root), not code_directory which may be stale.
        updateWorkspaceContext(`chat-${req.threadId}`, { workspaceName: meta.workspaceName, workspaceId: req.workspaceId, projectName: meta.projectName, projectId: req.projectId, projectDescription: meta.projectDescription, cwd: workspacePath, gitBranch: host.getGitBranch(workspacePath) });
      } catch (error) { console.warn("[cordis] workspace context update failed:", error instanceof Error ? error.message : error); }
      timer.mark("workspace-context (incl. git branch execSync, 800ms cap)");
      // Clarify the approval flow for the model. The dsh ASK_SENTENCE
      // ("Approval policy: ask...") is terse and the model was interpreting
      // it as "I should ask the user for permission in my text / via
      // ask_questions" instead of "just call the tool and the system will
      // show the approval card". This is especially confusing for EXTERNAL
      // tools like Tavily where the model thinks search is "not dangerous"
      // and hesitates. Make it explicit that the gating is automatic.
      const systemText = opts.approvals
        ? `${baseSystem}\n\n## Tool approvals\nExternal tools (like web search via Tavily) and destructive operations require user approval. To use them, simply call the tool — the system will automatically show an approval card to the user and pause your turn until they respond. Do NOT ask for permission in your text and do NOT use ask_questions to request approval. Just call the tool.`
        : baseSystem;
      await mount(cairnSystemPromptPlugin, { systemText });

      const doneIds = new Set<string>();
      const toolNames = new Map<string, string>();
      const toolArgs = new Map<string, string>();
      const streamDisposer = ctx.on("session/event", (session, event) => {
        if ((session as { header?: { origin?: string } }).header?.origin === "subagent") return;
        if ((session as { id?: unknown }).id !== currentAttemptSessionId) return;
        if (event.type === "request/header") {
          requestHeaderCount += 1;
          requestHeaderAtMs ??= Date.now() - wallStart;
        }
        if (TIMING && (event.type === "request/header" || event.type === "request/context")) {
          if (event.type === "request/header") {
            console.log(`[timing] request/header #${requestHeaderCount} at ${Date.now() - turnStart}ms${requestHeaderCount > 1 ? "  ⚠️ RETRY — previous attempt did not stream a token" : ""}`);
          } else {
            markLog(`event ${event.type} (request assembled → about to hit provider)`, turnStart);
          }
        }
        if (event.type === "assistant/chunk") {
          const c = (event.data as { chunk?: { type?: string; text?: string } }).chunk;
          if (c?.type === "text-delta" && c.text) { noteFirstToken(); liveText += c.text; opts.onToken?.(c.text); }
          else if (c?.type === "reasoning-delta" && c.text) { noteFirstToken(); liveReasoning += c.text; opts.onThought?.(c.text); }
          return;
        }
        if (event.type === "assistant/message" && !liveReasoning) {
          const content = (event.data as { message?: { content?: Array<{ type?: string; text?: string }> } }).message?.content;
          const value = Array.isArray(content) ? content.filter((b) => b.type === "reasoning" && b.text).map((b) => b.text).join("") : "";
          if (value) { liveReasoning += value; opts.onThought?.(value); }
          return;
        }
        if (event.type === "tool/call") {
          const d = event.data as { name?: string; arguments?: string; callId?: string };
          if (d.callId) { toolNames.set(d.callId, d.name ?? "tool"); toolArgs.set(d.callId, d.arguments ?? ""); }
          opts.emitToolCall?.({ tool: d.name ?? "tool", label: d.name ?? "tool", args: parseArgs(d.arguments), callId: d.callId });
          return;
        }
        if (event.type === "tool/result") {
          const d = event.data as { meta?: unknown; message?: { source?: { callId?: string }; content?: Array<{ isError?: boolean; content?: Array<{ type?: string; text?: string }> }> } };
          const callId = d.message?.source?.callId;
          if (!callId || doneIds.has(callId)) return;
          const block = d.message?.content?.[0];
          const error = block?.isError === true;
          const output = block?.content?.filter((b) => b.type === "text" && b.text).map((b) => b.text).join("") ?? "";
          const tool = toolNames.get(callId) ?? "tool";
          const meta = (d.meta as Record<string, unknown> | undefined) ?? (!error ? resolvePresentationMeta(tool, toolArgs.get(callId), output) as Record<string, unknown> | undefined : undefined);
          opts.emitToolCallDone?.({ tool, callId, cairnRef: (meta?.cairnRef ?? extractCairnRef(tool, output)) as { type: "note" | "task"; id: string; title: string } | undefined, output: error ? undefined : output, ok: !error, error: error ? output || "tool error" : undefined, ...(meta ? { meta } : {}) });
        }
      });
      resources.add(streamDisposer);

      const emitDone: NonNullable<RunCordisLoopOptions["emitToolCallDone"]> = (event) => {
        if (event.callId) doneIds.add(event.callId);
        opts.emitToolCallDone?.(event);
      };
      // Chat has the same HITL seam as coding, but only EXTERNAL (MCP/service)
      // and EXEC (bash/subagent) are gated — Cairn DB writes (notes/tasks) are
      // part of chat's core job and auto-allow, otherwise every note creation
      // would prompt. This is the risk-scoped policy chosen for per-workspace
      // "Always allow" (see plan note).
      const disposers = registerCairnTools(ctx, { getDb: () => (ctx.get(CAIRN_DB) as Database) ?? db, req, workspacePath, llmConfig: preparedConfig, getWin: opts.getWin, emit: undefined, emitDone });
      disposers.forEach((dispose) => resources.add(dispose));
      // Doom-loop guard (same as coding): pause on repeated identical calls.
      // Mounted BEFORE the approval plugin — see run-cordis-coding.ts comment
      // — so every gated call counts toward detection.
      if (opts.approvals) {
        await mount(cairnDoomLoopPlugin, { sessionId: `chat-${req.threadId}`, signal });
        await mount(cairnApprovalPlugin, {
          mode: "interactive",
          sessionId: `chat-${req.threadId}`,
          send: opts.approvals.send,
          registerPending: opts.approvals.registerPending,
          signal,
          workspaceId: req.workspaceId ?? undefined,
          host: createHostStore(db),
          askRiskClasses: new Set(["EXTERNAL", "EXEC"] as const),
          askFilter: (name: string) => name === "delete_note" || name === "delete_task" || name === "delete_project",
        });
      }
      // Workspace-scoped external tools (MCP/service) — chat's reason to have
      // the approval seam. Gated, so an unknown connector can't mutate
      // externally without confirmation.
      try {
        const extDisposers = await registerExternalCairnTools(ctx, { db, workspaceId: req.workspaceId ?? "", projectId: req.projectId ?? "" });
        extDisposers.forEach((d) => resources.add(d));
      } catch (e) {
        console.warn("[cordis] registerExternalCairnTools (chat) failed:", (e as Error)?.message ?? e);
      }
      markLog("setup (plugins + tool registration)", turnStart);
      timer.mark("registerCairnTools (recompiles every schema)");
    },
    open: async ({ llmConfig: preparedConfig }) => {
      const openStart = markNow();
      const cached = chatAgents.get(req.threadId);
      // A model change is bound into the agent at creation (agentOptions/adapter),
      // so it requires a fresh agent. Reasoning effort, by contrast, is pure
      // request-header state dsh re-reads from the mutable selection ref each step
      // — update it in place so an effort change takes effect on the next turn
      // WITHOUT a resume/replay. (See installModelSelection in dsh-agent.)
      const cachedModel = cached?.selectionRef?.current?.model;
      const modelChanged = cachedModel !== undefined && cachedModel !== preparedConfig.model;
      if (cached && modelChanged) {
        await dropChatAgentForThread(req.threadId);
      } else if (cached) {
        // Selection ref can be mutated without a resume; session-turn's
        // pre-followup whenIdle serializes against an in-flight turn.
        if (cached.selectionRef?.current) {
          cached.selectionRef.current.reasoningEffort = preparedConfig.reasoningEffort;
        }
        // Return the live agent directly — runCordisTurn will await whenIdle
        // before followup, so no double-wait here (P0-3 double-wait hangs when
        // compaction holds the idle phase).
        const live = cached.agent;
        const sid = SessionId(`chat-${req.threadId}`);
        try {
          const ctx2 = await getContext();
          // If the session was purged under us, drop the stale cache entry.
          if (!ctx2.sessions.get(sid as never)) {
            chatAgents.delete(req.threadId);
          } else {
            markLog("open (cache HIT)", openStart);
            return { agent: live, dispose: async () => {} };
          }
        } catch {
          markLog("open (cache HIT)", openStart);
          return { agent: live, dispose: async () => {} };
        }
      }
      try {
        const opened = await openCordisSessionAgent(ctx, { sessionId: `chat-${req.threadId}`, cwd: workspacePath, llmConfig: preparedConfig, signal });
        chatAgents.set(req.threadId, { handle: opened as unknown as Record<PropertyKey, unknown>, agent: opened.agent as Record<PropertyKey, unknown>, selectionRef: opened.selectionRef });
        markLog("open (cache MISS — resume/replay JSONL)", openStart);
        return opened;
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes("while it is live")) throw error;
        await dropChatAgentForThread(req.threadId);
        const opened = await openCordisSessionAgent(ctx, { sessionId: `chat-${req.threadId}`, cwd: workspacePath, llmConfig: preparedConfig, signal });
        chatAgents.set(req.threadId, { handle: opened as unknown as Record<PropertyKey, unknown>, agent: opened.agent as Record<PropertyKey, unknown>, selectionRef: opened.selectionRef });
        return opened;
      }
    },
    run: async ({ agent }) => {
      const runStart = markNow();
      timer.mark("open agent (cache hit, or resume/replay JSONL)");
      const typed = agent as unknown as CordisTurnAgent & { session: unknown };
      currentAttemptSessionId = SessionId(`chat-${req.threadId}`);
      const content = await buildCordisUserContent(ctx, req.message, req.images);
      markLog("run: content built, dispatching followup", runStart);
      timer.mark("build user content (pre-turn setup total)");
      const { firstSeq } = await runCordisTurn({ agent: typed, content, signal });
      timer.mark("model turn (followup → idle)");
      // Post-turn durability: the write-behind batches on a 200ms timer and
      // retained chat agents skip the disposal drain, so a crash right after
      // idle would lose the final batch. The plugin already flushes in
      // session-turn.ts; this is a second best-effort barrier at the
      // presentation layer (idempotent if already flushed).
      try {
        const { flushSession } = await import("./plugins/session-durability");
        await flushSession(ctx as never, (typed as unknown as { session?: unknown }).session);
      } catch { /* best-effort */ }
      const sessionEvents = readSessionEvents(typed.session);
      const result = collect(sessionEvents, firstSeq);
      const end = sessionEvents.filter((event) => event.seq >= firstSeq && event.type === "turn/end").at(-1);
      const kind = (end?.data as { reason?: { kind?: string } } | undefined)?.reason?.kind;
      // The provider only streams {inputTokens, outputTokens} on its usage events,
      // so the renderer's live fold persists a breakdown-less lastUsage and the
      // Context Ring falls back to "Tool outputs 0". The real breakdown is only
      // computable by char-counting the WHOLE event log (request/header system +
      // tools, tool/result outputs, etc.) — exactly what the reload path does via
      // foldSessionUsage. Emit one synthetic, breakdown-carrying usage event so the
      // live ring matches the reload ring (single source of truth, no divergence).
      emitBreakdownUsage(sessionEvents, opts.onSessionEvent);
      emitTurnStats(sessionEvents, opts.onSessionEvent);
      if (TIMING && kind && kind !== "completed") console.log(`[timing] turn/end kind="${kind}" at ${Date.now() - turnStart}ms (attempt did not complete cleanly)`);
      return { ...result, failedKind: kind && kind !== "completed" ? kind : undefined };
    },
  });

  let attempt: Awaited<ReturnType<typeof runAttempt>>;
  try {
    attempt = await runAttempt();
  } catch (err) {
    if (err instanceof Error && err.message.includes("while it is live")) {
      console.warn("[chat] retrying live session after drop", (err as Error).message);
      await dropChatAgentForThread(req.threadId);
      attempt = await runAttempt();
    } else {
      throw err;
    }
  }
  // NOTE: the old responses→completions auto-downgrade was removed. It existed
  // to recover from a wrong transport probe, but Cairn now pins the wire
  // protocol explicitly per provider (apiMode, default completions) and never
  // probes — so silently switching protocols mid-session would only REINTRODUCE
  // the cross-API replay corruption this change eliminates. A pinned-protocol
  // failure surfaces (and dsh's own retryPolicy already handles transient
  // transport errors within the same protocol).
  const content = liveText || attempt.text;
  const reasoning = liveReasoning || attempt.reasoning;
  if (opts.onUsage && (attempt.pt > 0 || attempt.ct > 0)) opts.onUsage(attempt.pt, attempt.ct, attempt.rt);
  // `providerTtftMs` is the wait AFTER Cairn handed the assembled request to the
  // provider. When it dominates totalMs, the latency is upstream (model, proxy,
  // network) and no amount of Cairn-side optimisation will help; `promptTokens`
  // and `requestHeaderCount` are recorded alongside it because prefill size and
  // silent retries are the two things that do move that number.
  timer.end("chat turn finished", {
    ...(requestHeaderAtMs !== undefined ? { requestSentAtMs: requestHeaderAtMs } : {}),
    ...(firstTokenAtMs !== undefined ? { firstTokenAtMs } : {}),
    ...(requestHeaderAtMs !== undefined && firstTokenAtMs !== undefined
      ? { providerTtftMs: firstTokenAtMs - requestHeaderAtMs }
      : {}),
    requestHeaderCount,
    promptTokens: attempt.pt,
    completionTokens: attempt.ct,
    reasoningTokens: attempt.rt,
    ...(attempt.failedKind ? { failedKind: attempt.failedKind } : {}),
  });
  return { exhausted: signal?.aborted === true, content, reasoning };
}
