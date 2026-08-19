/**
 * run-cordis-loop — drive the dsh agent loop (dsh-agent-loop) with Cairn's
 * tools bridged on, using dsh's production `dsh-llm-pi-ai` multi-protocol
 * adapter (openai-completions / openai-responses). Maps the resulting session
 * events onto the same contract as electron/lib/chat-loop.ts `runToolLoop` so
 * electron/ipc/chat.ts can swap engines behind a toggle.
 */
import { Context } from "@deepseek-ai/cordis";
import sessionPlugin from "@deepseek-ai/dsh-session";
import llmPlugin from "@deepseek-ai/dsh-llm";
import systemPromptPlugin from "@deepseek-ai/dsh-system-prompt";
import agentPlugin from "@deepseek-ai/dsh-agent";
import toolsPlugin from "@deepseek-ai/dsh-tools";
import agentLoopPlugin from "@deepseek-ai/dsh-agent-loop";
import { apply as llmPiAiApply, inject as llmPiAiInject, name as llmPiAiName } from "@deepseek-ai/dsh-llm-pi-ai";
import { installModelSelection } from "@deepseek-ai/dsh-agent";
import { SessionId, type SessionEvent } from "@deepseek-ai/dsh-session";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import subagentServicePlugin from "@deepseek-ai/dsh-subagent";
import userQuestionsService from "@deepseek-ai/dsh-user-questions";
import { apply as spawnProviderApply, inject as spawnProviderInject, name as spawnProviderName } from "@deepseek-ai/dsh-subagent-spawn-in-process";
import { apply as toolSubagentApply, inject as toolSubagentInject, name as toolSubagentName } from "@deepseek-ai/dsh-tool-subagent";
import type { Database } from "better-sqlite3";
import JsonlSessionPersistence from "@deepseek-ai/dsh-session-persistence-jsonl";
import approvalService from "@deepseek-ai/dsh-user-approval";
import TokenMeter from "@deepseek-ai/dsh-token-meter";
import BasicCompactionEngine from "@deepseek-ai/dsh-compaction-basic";
import { apply as llmRetryApply, inject as llmRetryInject, name as llmRetryName } from "@deepseek-ai/dsh-llm-retry";
import { CairnAttachmentStore } from "./cairn-attachment-store";
import { buildCordisUserContent } from "./cairn-attachment-store";
import path from "path";

import { registerCairnTools, registerExternalCairnTools } from "./cairn-tools";
import { cairnDbPlugin, cairnSessionPlugin, cairnUsagePlugin, cairnSubagentPlugin, cairnSystemPromptPlugin, cairnQuestionsPlugin, CAIRN_DB } from "./cairn-plugins";
import { buildSystemPrompt, withPersonality } from "../lib/tools";
import { resolveTransport, markCompletionsOnly, readCachedMode, type ApiMode } from "../lib/llm-transport";
import type { ChatRequest } from "../lib/tools";
import type { LLMConfig } from "../lib/llm";

export interface RunCordisLoopResult {
  exhausted: boolean;
  content: string;
  reasoning: string;
  reasoningSummary?: string;
  reasoningItems?: Array<Record<string, unknown>>;
  reasoningField?: string;
  reasoningModel?: string;
}

export interface RunCordisLoopOptions {
  db: Database;
  req: ChatRequest;
  workspacePath: string;
  llmConfig: LLMConfig;
  onToken?: (delta: string) => void;
  onThought?: (delta: string) => void;
  onUsage?: (pt: number, ct: number, rt?: number, costUsd?: number, cacheReadTokens?: number, cacheCreationTokens?: number) => void;
  emitToolCall?: (e: { tool: string; label: string; args: Record<string, unknown>; callId?: string }) => void;
  emitToolCallDone?: (e: { tool: string; cairnRef?: { type: "note" | "task"; id: string; title: string }; externalRef?: { url: string; title?: string; snippet?: string }; output?: string; callId?: string; ok?: boolean; error?: string }) => void;
  /** Emit a live subagent trace event (threadId tagged by the caller). */
  sendSubagent?: (channel: string, payload: Record<string, unknown>) => void;
  /**
   * Interactive questions (ask_questions) via the dsh user-questions seam.
   * `send` emits the question IPC to the renderer; `registerPending` stores a
   * resolver keyed by requestId that the caller's IPC answer-handler invokes
   * with the answer text. When omitted, ask_questions falls back to the shared
   * echo executor (no blocking).
   */
  questions?: {
    send: (channel: string, payload: Record<string, unknown>) => void;
    registerPending: (requestId: string, resolve: (answersText: string) => void) => () => void;
  };
  getWin?: () => Electron.BrowserWindow | null;
  signal?: AbortSignal;
}

// ── Shared Cordis context + pi-ai adapter lifecycle ─────────────────────────
let sharedCtx: Context | null = null;
let contextReady: Promise<Context> | null = null;
// The dsh session-persistence root (jsonl session logs live here, NOT in Cairn's
// SQLite — the DB is for MCP/tool access only). Configured by the Electron main
// process via setSessionRoot(); falls back to CAIRN_SESSION_ROOT or cwd.
let sessionRoot = process.env.CAIRN_SESSION_ROOT || path.join(process.cwd(), ".cairn-sessions");
/** Configure the directory where dsh persists its session logs (must be set
 *  before the first getContext()). The Electron main calls this with
 *  app.getPath("userData") + "/sessions". */
export function setSessionRoot(root: string): void {
  sessionRoot = root;
}
// The pi-ai provider route ("cairn") is registered once; its profile carries
// the endpoint. Track the last config so a changed baseURL/model remounts it.
let piAiDisposer: (() => Promise<void>) | null = null;
let lastPiAiConfig: { baseUrl: string; model: string; apiKey: string; api: "openai-completions" | "openai-responses" } | null = null;

export async function getContext(): Promise<Context> {
  if (sharedCtx) return sharedCtx;
  if (contextReady) return contextReady;
  contextReady = (async () => {
    const ctx = new Context();
    await ctx.plugin(sessionPlugin);
    await ctx.plugin(llmPlugin);
    // Cairn owns the whole system prompt (buildSystemPrompt), so suppress dsh's
    // built-in harness identity — the per-request persona section (registered in
    // each agent's setup) is the only identity the model sees.
    await ctx.plugin(systemPromptPlugin, { persona: "", includeHarnessIdentity: false });
    await ctx.plugin(agentPlugin);
    await ctx.plugin(toolsPlugin, { mode: "native" });
    // dsh user-questions capability seam (ctx.userQuestions): lets a tool pause
    // the turn until the human answers. The model-facing tool (dsh-tool-ask-user)
    // is unpublished, so Cairn keeps its own `ask_questions` tool whose body
    // calls ctx.userQuestions.ask(); cairnQuestionsPlugin registers the provider
    // that bridges ask() ⇄ the renderer form. Mounted before the agent loop.
    await ctx.plugin(userQuestionsService);
    // dsh approval seam (ctx.approval): tools/pre-execute `ask` decisions route
    // here; cairnApprovalPlugin registers the answerer that bridges to Cairn's
    // renderer confirm UI. Policy 'ask' — the per-turn approval guard decides
    // WHICH tools ask (only when autoApprove is off).
    await ctx.plugin(approvalService, { policy: "ask" });
    // dsh session persistence (jsonl). Session/chat transcripts live HERE, not in
    // Cairn's SQLite (the DB is for MCP/tool access). Enables stateful, resumable
    // coding sessions via ctx.agents.resume. Self-contained backend (owns its own
    // PersistenceCoordinator + provides ctx.sessionPersistence).
    await ctx.plugin(JsonlSessionPersistence, { root: sessionRoot });
    await ctx.plugin(agentLoopPlugin, { agents: [] });
    // Durable attachment store (Phase 1.5 step 2l). Concrete backend for the
    // abstract dsh AttachmentStore so image attachments on a message can be
    // admitted (saveImage -> ImageAttachmentRef) and read back by the pi-ai
    // adapter (resolveAttachments: () => ctx.get("attachments")) when it converts
    // an ImageBlock to the wire image_url. Without it, pi-ai drops images.
    await ctx.plugin(CairnAttachmentStore);
    // Context management (Phase 1.5 step 2h). tokenMeter measures request +
    // surface pressure; BasicCompactionEngine auto-compacts between steps at 80%
    // of the model's context window (auto:true) and on provider context-overflow,
    // replacing the compacted span with one summary node — the dsh-native
    // replacement for Cairn's buildCompactionTransformer. dsh owns the session
    // log (jsonl) so its compaction engine is the natural fit. Manual /compact is
    // available via ctx.compaction.compactNow(agent). llm-retry executes the
    // provider-owned retryPolicy on the agent loop's request-recovery seam,
    // recording durable llm/retry events the coding bridge maps to pi-agent:retry.
    await ctx.plugin(TokenMeter);
    await ctx.plugin(BasicCompactionEngine, { auto: true, thresholdRatio: 0.8 });
    await ctx.plugin({ apply: llmRetryApply, inject: llmRetryInject as never, name: llmRetryName }, {});
    // Subagent capability stack (dsh-base order): service → spawn provider → tool.
    await ctx.plugin(subagentServicePlugin);
    await ctx.plugin({ apply: spawnProviderApply, inject: spawnProviderInject as never, name: spawnProviderName }, { providerName: "spawn" });
    await ctx.plugin({ apply: toolSubagentApply, inject: toolSubagentInject as never, name: toolSubagentName }, { provider: "spawn", toolName: "subagent", backgroundMode: "one-shot" });
    sharedCtx = ctx;
    return ctx;
  })();
  return contextReady;
}

/**
 * (Re)mount the pi-ai adapter for the current endpoint. The provider route
 * "cairn" is registered once; if the endpoint/model changed, dispose the old
 * route first (the pi-ai plugin owns a configurable-provider directory + route).
 */
export async function ensurePiAiAdapter(ctx: Context, config: { baseUrl: string; model: string; apiKey: string; api: "openai-completions" | "openai-responses" }): Promise<void> {  const same =
    piAiDisposer &&
    lastPiAiConfig &&
    lastPiAiConfig.baseUrl === config.baseUrl &&
    lastPiAiConfig.model === config.model &&
    lastPiAiConfig.api === config.api;
  if (same) return;

  if (piAiDisposer) {
    try { await piAiDisposer(); } catch { /* noop */ }
    // Give the Cordis plugin system a tick to fully unregister the old
    // "cairn" provider route before re-registering with a new baseURL —
    // otherwise the pi-ai adapter sees "already declared".
    await new Promise<void>((r) => setTimeout(r, 0));
  }
  piAiDisposer = null;

  // pi-ai resolves credentials through an apiKeyEnv; the endpoint ignores auth
  // for local endpoints, so surface a literal key when one is configured and a
  // harmless placeholder otherwise (never sent meaningfully).
  process.env.CAIRN_LLM_API_KEY = config.apiKey || "local";
  const apiKeyEnv = "CAIRN_LLM_API_KEY";
  const handle = ctx.plugin(
    { name: llmPiAiName, inject: llmPiAiInject, apply: llmPiAiApply },
    {
      providers: {
        cairn: {
          api: config.api,
          baseURL: config.baseUrl,
          displayName: "Cairn",
          models: [{ id: config.model, contextWindow: 262144, maxTokens: 32768 }],
          apiKeyEnv,
          // Declare image input so the pi-ai route accepts ImageBlocks (step 2l).
          // Cairn's endpoint is a multi-provider gateway; images pass through as
          // OpenAI image_url parts. Text-only models still work (an image is only
          // sent when the user actually attaches one).
          defaultInput: ["text", "image"],
          // Provider-owned transient-failure retry policy; executed by
          // dsh-llm-retry on the agent loop's request-recovery seam. Bounded
          // exponential backoff, mirroring Cairn's built-in loop retry behaviour.
          retryPolicy: {
            mode: "normal",
            maxRetries: 5,
            backoff: { initialDelayMs: 500, maxDelayMs: 10000, jitterRatio: 0.1 },
          },
        },
      },
    },
  );
  await handle;
  piAiDisposer = async () => { try { const h = await handle; h.dispose(); } catch { /* noop */ } };
  lastPiAiConfig = config;
}

/** Collect final assistant text + reasoning + usage from new session events. */
function collect(events: readonly SessionEvent[], firstSeq: number): { text: string; reasoning: string; pt: number; ct: number; rt: number } {
  let text = "";
  let reasoning = "";
  let pt = 0, ct = 0, rt = 0;
  let started = false;
  for (const e of events) {
    if (e.seq < firstSeq) continue;
    if (e.type === "turn/start") { started = true; continue; }
    if (!started) continue;
    if (e.type === "assistant/chunk") {
      const c = (e.data as { chunk?: { type?: string; text?: string; usage?: { inputTokens?: number; outputTokens?: number; reasoningTokens?: number } } }).chunk;
      if (!c) continue;
      if (c.type === "text-delta" && c.text) text += c.text;
      if (c.type === "reasoning-delta" && c.text) reasoning += c.text;
      if (c.type === "usage" && c.usage) {
        pt = Math.max(pt, c.usage.inputTokens ?? 0);
        ct += c.usage.outputTokens ?? 0;
        rt += c.usage.reasoningTokens ?? 0;
      }
    }
    // Fallback: some protocols (e.g. openai-responses) don't stream reasoning as
    // deltas — the reasoning lives only in the final message's reasoning block.
    if (e.type === "assistant/message" && !reasoning) {
      const content = (e.data as { message?: { content?: Array<{ type?: string; text?: string }> } }).message?.content;
      if (Array.isArray(content)) {
        reasoning = content.filter((b) => b.type === "reasoning" && b.text).map((b) => b.text).join("");
      }
    }
  }
  return { text, reasoning, pt, ct, rt };
}

/**
 * Run one chat turn through the dsh agent loop. Mirrors runToolLoop's external
 * contract so electron/ipc/chat.ts can call either engine.
 */
export async function runCordisLoop(opts: RunCordisLoopOptions): Promise<RunCordisLoopResult> {
  const ctx = await getContext();
  const { db, req, workspacePath, llmConfig, signal } = opts;

  // Pick the wire protocol the SAME way the built-in loop does: reuse Cairn's
  // probe-and-cache transport resolver (electron/lib/llm-transport.ts). It
  // resolves /responses vs /chat/completions ONCE per base URL (static allowlist
  // for OpenAI/Azure; an empty-body /responses route probe for everything else)
  // and caches the answer for the app session. We then map that to pi-ai's
  // adapter mode. A runtime fallback below downgrades a provider that turns out
  // not to speak /responses after all (markCompletionsOnly + retry).
  const transport = await resolveTransport(llmConfig.baseUrl, llmConfig.apiKey);
  const apiFor = (mode: ApiMode): "openai-responses" | "openai-completions" =>
    mode === "responses" ? "openai-responses" : "openai-completions";
  await ensurePiAiAdapter(ctx, {
    baseUrl: llmConfig.baseUrl,
    model: llmConfig.model,
    apiKey: llmConfig.apiKey,
    api: apiFor(transport.mode),
  });

  // Cairn's own plugins: cairn-db owns the handle, cairn-session persists
  // messages, cairn-usage records usage. Mounted per call (lightweight event
  // listeners); disposed in finally.
  const pluginDisposers: Array<() => void> = [];
  const mount = async (plugin: unknown, config: unknown): Promise<void> => {
    const fiber = ctx.plugin(plugin as never, config as never);
    pluginDisposers.push(() => { fiber.then((f) => { try { f.dispose(); } catch { /* noop */ } }, () => {}); });
    await fiber;
  };
  await mount(cairnDbPlugin, { db });
  await mount(cairnSessionPlugin, {
    threadId: req.threadId,
    workspaceId: req.workspaceId ?? "",
    projectId: req.projectId,
  });
  await mount(cairnUsagePlugin, {
    threadId: req.threadId,
    workspaceId: req.workspaceId ?? "",
    projectId: req.projectId,
    provider: llmConfig.provider,
    model: llmConfig.model,
    baseUrl: llmConfig.baseUrl,
  });
  if (opts.sendSubagent) {
    await mount(cairnSubagentPlugin, { send: opts.sendSubagent });
  }
  if (opts.questions) {
    await mount(cairnQuestionsPlugin, {
      send: opts.questions.send,
      registerPending: opts.questions.registerPending,
      signal,
    });
  }

  // Cairn's full system prompt (identity + tool rules + date), personality
  // layered on, with prior conversation folded in as a transcript. dsh creates a
  // fresh session per turn (a new sessionId each call), so this transcript is
  // what carries context across turns — without it the model loses everything
  // from earlier turns (the "only worked on the second message" symptom).
  // Replaying raw events into the session would have to satisfy dsh's
  // surface/seq invariants; a transcript is robust and needs no bookkeeping.
  // Mounted as a plugin (like the other cairn-* plugins) rather than inline in
  // the agent's setup(); cairnSystemPromptPlugin registers it as a prompt section.
  const baseSystem = withPersonality(buildSystemPrompt(req), req.personality);
  const history = (req.history ?? [])
    .filter((h) => (h.role === "user" || h.role === "assistant") && typeof h.content === "string" && h.content.trim())
    .map((h) => `${h.role === "user" ? "User" : "Assistant"}: ${(h.content as string).trim()}`);
  const systemText = history.length
    ? `${baseSystem}\n\n## Conversation so far\n${history.join("\n\n")}`
    : baseSystem;
  await mount(cairnSystemPromptPlugin, { systemText });

  const toolDisposers = registerCairnTools(ctx, {
    getDb: () => (ctx.get(CAIRN_DB) as Database) ?? db,
    req,
    workspacePath,
    llmConfig,
    getWin: opts.getWin,
    emit: opts.emitToolCall,
    emitDone: opts.emitToolCallDone,
  });
  // User-configured MCP servers + custom services onto ctx.tools.
  const externalDisposers = await registerExternalCairnTools(ctx, {
    db,
    workspaceId: req.workspaceId ?? "",
    projectId: req.projectId ?? "",
  });
  toolDisposers.push(...externalDisposers);

  const selection = { provider: "cairn", model: llmConfig.model };

  // Live-stream text + reasoning deltas as they arrive on the MAIN session
  // (subagent children are handled by cairnSubagentPlugin). We also keep a
  // running buffer as the durable return value / fallback if no deltas fired.
  // The active attempt's sessionId is set by runTurn (a retry uses a fresh id).
  let currentAttemptSessionId: unknown = null;
  let liveText = "";
  let liveReasoning = "";
  const streamDisposer = (ctx as unknown as { on: (ev: string, fn: (s: unknown, e: SessionEvent) => void) => () => void }).on(
    "session/event",
    (session, event) => {
      if ((session as { header?: { origin?: string } }).header?.origin === "subagent") return;
      if ((session as { id?: unknown }).id !== currentAttemptSessionId) return;
      if (event.type === "assistant/chunk") {
        const c = (event.data as { chunk?: { type?: string; text?: string } }).chunk;
        if (!c?.text) return;
        if (c.type === "text-delta") { liveText += c.text; opts.onToken?.(c.text); }
        else if (c.type === "reasoning-delta") { liveReasoning += c.text; opts.onThought?.(c.text); }
        return;
      }
      // Fallback for protocols that don't stream reasoning as deltas (e.g.
      // openai-responses): emit the final message's reasoning block once so the
      // thinking panel still populates.
      if (event.type === "assistant/message" && !liveReasoning) {
        const content = (event.data as { message?: { content?: Array<{ type?: string; text?: string }> } }).message?.content;
        if (Array.isArray(content)) {
          const r = content.filter((b) => b.type === "reasoning" && b.text).map((b) => b.text).join("");
          if (r) { liveReasoning += r; opts.onThought?.(r); }
        }
      }
    },
  );

  // One turn attempt against the currently-mounted adapter. Returns the turn's
  // end reason so the caller can decide whether to downgrade + retry. A fresh
  // sessionId per attempt avoids resuming the failed session on a retry.
  const runTurn = async (): Promise<{ text: string; reasoning: string; pt: number; ct: number; rt: number; failedKind?: string }> => {
    const attemptSessionId = SessionId(`chat-${req.threadId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    currentAttemptSessionId = attemptSessionId;
    const { agent } = await ctx.agentLoop.createAgent(ctx, {
      sessionId: attemptSessionId,
      meta: { cwd: workspacePath },
      agentOptions: { provider: selection.provider, model: selection.model },
      setup: (agentCtx) => {
        installModelSelection(agentCtx, { current: selection, assembled: undefined });
      },
    });

    await agent.whenIdle();
    const firstSeq = agent.session.seq;

    // Build user content: text + image/PDF attachments (step 2l). Images become
    // ImageBlocks via the mounted attachment store; without this req.images is
    // dropped (chat has supported attachments in the builtin loop all along).
    const userContent = await buildCordisUserContent(ctx, req.message, req.images);
    agent.followup(
      createUserMessage({
        content: userContent as never,
        source: { kind: "user" },
      }),
    );
    await agent.whenIdle();

    const collected = collect(agent.session.events, firstSeq);
    // A turn that ended for any reason other than "completed" (an LLM/transport
    // error) with no produced content is the fallback trigger.
    const endEvent = agent.session.events.filter((e) => e.seq >= firstSeq && e.type === "turn/end").at(-1);
    const endKind = (endEvent?.data as { reason?: { kind?: string } } | undefined)?.reason?.kind;
    const failedKind = endKind && endKind !== "completed" ? endKind : undefined;
    return { ...collected, failedKind };
  };

  try {
    let attempt = await runTurn();

    // Runtime protocol fallback: if we were on /responses and the turn failed
    // with nothing produced, the endpoint likely doesn't actually serve
    // /responses (a stale probe, or it dropped the route). Downgrade the base
    // URL to chat-completions, remount the adapter, and retry the turn once.
    // OpenAI/Azure (static allowlist) are trusted and not downgraded.
    if (
      attempt.failedKind &&
      !attempt.text &&
      !attempt.reasoning &&
      readCachedMode(llmConfig.baseUrl) === "responses" &&
      !liveText
    ) {
      markCompletionsOnly(llmConfig.baseUrl);
      await ensurePiAiAdapter(ctx, {
        baseUrl: llmConfig.baseUrl,
        model: llmConfig.model,
        apiKey: llmConfig.apiKey,
        api: "openai-completions",
      });
      liveText = "";
      liveReasoning = "";
      attempt = await runTurn();
    }

    const pt = attempt.pt, ct = attempt.ct, rt = attempt.rt;
    // Prefer the live-streamed buffers; fall back to the post-hoc collection if
    // deltas never fired (e.g. a provider that only emits a final message).
    const text = liveText || attempt.text;
    const reasoning = liveReasoning || attempt.reasoning;
    if (opts.onUsage && (pt > 0 || ct > 0)) opts.onUsage(pt, ct, rt);

    return {
      exhausted: signal?.aborted === true,
      content: text,
      reasoning,
    };
  } finally {
    try { streamDisposer(); } catch { /* noop */ }
    toolDisposers.forEach((d) => { try { d(); } catch { /* noop */ } });
    pluginDisposers.forEach((d) => { try { d(); } catch { /* noop */ } });
  }
}
