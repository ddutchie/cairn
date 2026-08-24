import { SessionId, type SessionEvent } from "@deepseek-ai/dsh-session";
import type { Database } from "better-sqlite3";
import { buildCordisUserContent } from "./cairn-attachment-store";
import { registerCairnTools, registerExternalCairnTools, CHAT_FORBIDDEN_TOOLS } from "./cairn-tools";
import { cairnSystemPromptPlugin, CAIRN_DB } from "./cairn-plugins";
import { getChatAgentCache } from "./chat-agent-cache";
import { extractCairnRef } from "./session-replay";
import { openCordisSessionAgent } from "./session-agent";
import { runCordisTurn, type CordisTurnAgent } from "./session-turn";
import { runCordisSession } from "./session-runner";
import { ensureAgentAiAdapter } from "./session-runtime";
import { buildSystemPrompt, withPersonality } from "../lib/tools";
import { markCompletionsOnly, readCachedMode } from "../lib/llm-transport";
import type { RunCordisLoopOptions, RunCordisLoopResult } from "./run-cordis-loop";
import { dropChatAgentForThread, getContext, resolvePresentationMeta } from "./cordis-context";

type Collected = { text: string; reasoning: string; pt: number; ct: number; rt: number };

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

/** Chat-specific profile over the shared Cordis session lifecycle. */
export async function runChatCordisSession(opts: RunCordisLoopOptions): Promise<RunCordisLoopResult> {
  const ctx = await getContext();
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
        const h = await import("../lib/artifact-hygiene");
        h.migrateLegacyVizDir(workspacePath);
        h.ensureGitExcluded(workspacePath);
        h.pruneChatArtifacts(workspacePath, "viz");
      } catch { /* best-effort hygiene */ }
    }
  } catch (error) {
    console.error("[cordis] fs chain mount for plugins failed:", error instanceof Error ? error.message : error);
  }

  const baseSystem = withPersonality(buildSystemPrompt(req), req.personality);
  const chatAgents = getChatAgentCache();
  let liveText = "";
  let liveReasoning = "";
  let currentAttemptSessionId: unknown = null;

  const runAttempt = async (): Promise<Collected & { failedKind?: string }> => runCordisSession({
    ctx,
    db,
    req,
    sessionId: `chat-${req.threadId}`,
    llmConfig,
    signal,
    includeSessionIndex: true,
    sendSubagent: opts.sendSubagent,
    questions: opts.questions,
    retainAgent: true,
    setup: async ({ llmConfig: preparedConfig, resources, mount }) => {
      llmConfig = preparedConfig;
      try {
        const project = req.projectId ? db.prepare("SELECT name, description, code_directory FROM projects WHERE id = ?").get(req.projectId) as { name?: string; description?: string; code_directory?: string } | undefined : undefined;
        const workspace = req.workspaceId ? db.prepare("SELECT name FROM workspaces WHERE id = ?").get(req.workspaceId) as { name?: string } | undefined : undefined;
        const { updateWorkspaceContext } = await import("./plugins/workspace-context");
        updateWorkspaceContext(`chat-${req.threadId}`, { workspaceName: workspace?.name, projectName: project?.name, projectDescription: project?.description, cwd: project?.code_directory });
      } catch (error) { console.warn("[cordis] workspace context update failed:", error instanceof Error ? error.message : error); }
      await mount(cairnSystemPromptPlugin, { systemText: baseSystem });

      const doneIds = new Set<string>();
      const toolNames = new Map<string, string>();
      const toolArgs = new Map<string, string>();
      const streamDisposer = ctx.on("session/event", (session, event) => {
        if ((session as { header?: { origin?: string } }).header?.origin === "subagent") return;
        if ((session as { id?: unknown }).id !== currentAttemptSessionId) return;
        if (event.type === "assistant/chunk") {
          const c = (event.data as { chunk?: { type?: string; text?: string } }).chunk;
          if (c?.type === "text-delta" && c.text) { liveText += c.text; opts.onToken?.(c.text); }
          else if (c?.type === "reasoning-delta" && c.text) { liveReasoning += c.text; opts.onThought?.(c.text); }
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
      const disposers = registerCairnTools(ctx, { getDb: () => (ctx.get(CAIRN_DB) as Database) ?? db, req, workspacePath, llmConfig: preparedConfig, getWin: opts.getWin, emit: undefined, emitDone }, { exclude: CHAT_FORBIDDEN_TOOLS });
      disposers.forEach((dispose) => resources.add(dispose));
      (await registerExternalCairnTools(ctx, { db, workspaceId: req.workspaceId ?? "", projectId: req.projectId ?? "" })).forEach((dispose) => resources.add(dispose));
    },
    open: async ({ llmConfig: preparedConfig }) => {
      const cached = chatAgents.get(req.threadId);
      if (cached) {
        try { await (cached.whenIdle ?? (cached.agent as { whenIdle?: () => Promise<void> })?.whenIdle)?.(); return { agent: cached.agent, dispose: async () => {} }; }
        catch { chatAgents.delete(req.threadId); }
      }
      try {
        const opened = await openCordisSessionAgent(ctx, { sessionId: `chat-${req.threadId}`, cwd: workspacePath, llmConfig: preparedConfig, signal });
        chatAgents.set(req.threadId, { handle: opened as unknown as Record<PropertyKey, unknown>, agent: opened.agent as Record<PropertyKey, unknown> });
        return opened;
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes("while it is live")) throw error;
        await dropChatAgentForThread(req.threadId);
        const opened = await openCordisSessionAgent(ctx, { sessionId: `chat-${req.threadId}`, cwd: workspacePath, llmConfig: preparedConfig, signal });
        chatAgents.set(req.threadId, { handle: opened as unknown as Record<PropertyKey, unknown>, agent: opened.agent as Record<PropertyKey, unknown> });
        return opened;
      }
    },
    run: async ({ agent }) => {
      const typed = agent as unknown as CordisTurnAgent & { session: { events: readonly SessionEvent[] } };
      currentAttemptSessionId = SessionId(`chat-${req.threadId}`);
      const { firstSeq } = await runCordisTurn({ agent: typed, content: await buildCordisUserContent(ctx, req.message, req.images), signal });
      const result = collect(typed.session.events, firstSeq);
      const end = typed.session.events.filter((event) => event.seq >= firstSeq && event.type === "turn/end").at(-1);
      const kind = (end?.data as { reason?: { kind?: string } } | undefined)?.reason?.kind;
      return { ...result, failedKind: kind && kind !== "completed" ? kind : undefined };
    },
  });

  let attempt = await runAttempt();
  if (attempt.failedKind && !attempt.text && !attempt.reasoning && readCachedMode(llmConfig.baseUrl) === "responses" && !liveText) {
    markCompletionsOnly(llmConfig.baseUrl);
    await ensureAgentAiAdapter(ctx, { baseUrl: llmConfig.baseUrl, model: llmConfig.model, apiKey: llmConfig.apiKey, api: "openai-completions", contextWindow: llmConfig.contextWindow, maxTokens: llmConfig.maxTokens });
    liveText = "";
    liveReasoning = "";
    attempt = await runAttempt();
  }
  const content = liveText || attempt.text;
  const reasoning = liveReasoning || attempt.reasoning;
  if (opts.onUsage && (attempt.pt > 0 || attempt.ct > 0)) opts.onUsage(attempt.pt, attempt.ct, attempt.rt);
  return { exhausted: signal?.aborted === true, content, reasoning };
}
