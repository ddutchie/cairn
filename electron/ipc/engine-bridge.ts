/**
 * Bridge between the session IPC handlers and the Cairn-owned agent engine
 * (electron/agent). Opt-in while the dsh/Cordis runtime still exists:
 * `CAIRN_AGENT_ENGINE=native` or `agentConfig.engine: "native"` in the config
 * cache. Reads (messages, running state, pending asks) work for any session
 * that has a native log, whatever the toggle says.
 */
import path from "node:path";
import { randomBytes } from "node:crypto";
import os from "node:os";
import * as electron from "electron";
import { rgPath } from "@vscode/ripgrep";
import type { DbContext } from "./result-helpers";
import { broadcastEvent } from "./registry";
import { AgentHost } from "../agent/host";
import type { Profile } from "../agent/loop";
import type { Mode as EngineMode } from "../agent/policy";
import type { ModelRoute } from "../agent/provider";
import { canonicalCommand, presetRules, type Rule } from "../agent/rules";
import { buildToolset } from "../agent/tools/index";
import { importDshSession } from "../agent/session/dsh-import";
import { isLocalEndpoint } from "../lib/llm";
import { getAgentHost } from "../cordis/agent-host";
import { recordUsage } from "../cordis/host-store";
import { buildSystemPrompt, withPersonality, type ChatRequest } from "../lib/tools";
import { CHAT_EXCLUDED_TOOLS } from "../lib/tool-schemas";
import { resolveChatApprovalPolicy, type ChatApprovalPolicy } from "../../shared/agent/chat-approval";
import { addWorkspaceApprovalGrant, getWorkspaceApprovalGrants } from "../db/approval-grant-queries";
import { getCachedConfig } from "../lib/config-cache";
import { notifyAgentAttention } from "../lib/agent-attention";
import { routeFromConfig } from "../agent/route";
import type { AgentLLMConfig } from "../lib/session-runtime-types";
import type { Mode } from "../../shared/agent/approval-mode";
import { makeSessionProjection } from "../../shared/agent/session-projection";

export { routeFromConfig };

export function engineEnabled(): boolean {
  if (process.env.CAIRN_AGENT_ENGINE) return process.env.CAIRN_AGENT_ENGINE === "native";
  return (getCachedConfig().agentConfig as { engine?: string } | undefined)?.engine === "native";
}

/** Legacy approval modes onto engine modes. `auto` here keeps its old meaning: allow everything except EXTERNAL. */
export function engineProfile(mode: Mode | undefined, role: "default" | "automation-dev" | undefined): Profile {
  const engineMode: EngineMode = mode === "discuss" || mode === "plan" ? "plan" : mode === "auto" ? "yolo" : "ask";
  return {
    id: role === "automation-dev" ? "automation-dev" : "coding",
    interactive: true,
    mode: engineMode,
    externalAlwaysAsks: engineMode === "yolo",
  };
}

/**
 * Chat approvals as engine policy. `safe` asks for deletes (WRITE_LOCAL) and connector calls (EXTERNAL)
 * simply because nothing allows them; `external` adds an allow for deletes; `allow-all` is yolo.
 * Grants stay overridable, which an `ask` rule would not be.
 */
export function chatEngineProfile(policy: ChatApprovalPolicy): { profile: Profile; rules: Rule[] } {
  const rules: Rule[] = policy === "external"
    ? [{ id: "policy:chat-external-delete", effect: "allow", scope: "global", source: "preset", match: { tool: "delete" }, note: "Chat policy: external approve" }]
    : [];
  return { profile: { id: "chat", interactive: true, mode: policy === "allow-all" ? "yolo" : "ask" }, rules };
}

export function chatSystemPrompt(req: ChatRequest, policy: ChatApprovalPolicy): string {
  const base = withPersonality(buildSystemPrompt(req), req.personality);
  if (policy === "allow-all") return base;
  return `${base}\n\n## Tool approvals\nExternal tools (like web search via Tavily)${policy === "safe" ? " and destructive operations" : ""} require user approval. To use them, simply call the tool — the system will automatically show an approval card to the user and pause your turn until they respond. Do NOT ask for permission in your text and do NOT use ask_questions to request approval. Just call the tool.`;
}

export const chatApprovalPolicyFor = (req: ChatRequest): ChatApprovalPolicy =>
  resolveChatApprovalPolicy(req.approvalPolicy ?? (getCachedConfig().aiConfig as { chatApprovalPolicy?: unknown } | undefined)?.chatApprovalPolicy);

function grantsToRules(sessionId: string, grants: Array<{ id: string; tool: string; target: string | null }>): Rule[] {
  return grants.map((g) => ({
    id: `workspace:${g.id}`,
    effect: "allow" as const,
    scope: "workspace" as const,
    source: "grant" as const,
    match: g.target ? { tool: g.tool, command: { exact: canonicalCommand(g.target) } } : { tool: g.tool },
    note: `Workspace grant (${sessionId})`,
  }));
}

// ── singleton host ───────────────────────────────────────────────────────

let host: AgentHost | undefined;
let hostCtx: DbContext | undefined;
const sessionWorkspace = new Map<string, string>();
const sessionRules = new Map<string, Rule[]>();
interface UsageMeta { source: "chat" | "coding"; workspaceId: string; projectId?: string; provider?: string; model: string; baseUrl: string }
const usageMeta = new Map<string, UsageMeta>();
const observedFiles = new Map<string, Set<string>>();

interface PendingQuestion { nonce: string; resolve(answers: string): void; reject(err: Error): void }
const pendingQuestions = new Map<string, PendingQuestion>();
const qKey = (sessionId: string, callId: string) => `${sessionId}::${callId}`;

export function getEngineHost(ctx: DbContext): AgentHost {
  hostCtx = ctx;
  host ??= new AgentHost({
    root: hostRoot(),
    send: (channel, payload) => broadcastEvent(channel, payload),
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
      if (hostCtx) notifyAgentAttention(hostCtx.db, { sessionId: ask.sessionId, kind: "approval", detail: ask.title });
    },
  });
  return host;
}

/** True when the engine owns this session (it has a live run or a native log). */
export async function engineOwns(ctx: DbContext, sessionId: string): Promise<boolean> {
  const h = getEngineHost(ctx);
  if (h.isRunning(sessionId)) return true;
  return (await h.title(sessionId).catch(() => null)) !== null || (await h.loadMessages(sessionId).then((m) => m.messages.length > 0, () => false));
}

export function answerQuestion(sessionId: string, callId: string, nonce: string | undefined, answers: string): boolean {
  const pending = pendingQuestions.get(qKey(sessionId, callId));
  if (!pending || !nonce || pending.nonce !== nonce) return false;
  pendingQuestions.delete(qKey(sessionId, callId));
  pending.resolve(answers);
  return true;
}

export function cancelQuestions(sessionId: string): void {
  for (const [key, p] of [...pendingQuestions]) {
    if (key.startsWith(`${sessionId}::`)) { pendingQuestions.delete(key); p.reject(new Error("cancelled")); }
  }
}

export interface EnginePromptArgs {
  ctx: DbContext;
  sessionId: string;
  prompt: string;
  cwd: string;
  projectId?: string;
  workspaceId?: string;
  systemPrompt: string;
  llmConfig: AgentLLMConfig;
  role?: "default" | "automation-dev";
  /** Chat threads run the same engine with the chat toolset and approval policy. */
  chat?: { req: ChatRequest; policy: ChatApprovalPolicy };
}

/** First native use of a session that only exists as a dsh log: bring its history over. */
async function adoptLegacySession(sessionId: string): Promise<void> {
  try {
    const dsh = getAgentHost().getSessionRoot();
    if (dsh && hostRoot()) await importDshSession(dsh, hostRoot(), sessionId);
  } catch (err) {
    console.warn(`[agent] legacy import skipped for ${sessionId}:`, err instanceof Error ? err.message : err);
  }
}

/** Native session logs live beside the legacy ones; a missing Electron `app` (unit tests) falls back to tmp. */
function hostRoot(): string {
  let base: string;
  try { base = electron.app.getPath("userData"); } catch { base = os.tmpdir(); }
  return path.join(base, "sessions-native");
}

export async function runEnginePrompt(a: EnginePromptArgs): Promise<void> {
  const h = getEngineHost(a.ctx);
  await adoptLegacySession(a.sessionId);
  if (a.workspaceId) sessionWorkspace.set(a.sessionId, a.workspaceId);
  const chat = a.chat;
  const chatProfile = chat ? chatEngineProfile(chat.policy) : undefined;
  sessionRules.set(a.sessionId, chatProfile?.rules ?? []);
  usageMeta.set(a.sessionId, {
    source: chat ? "chat" : "coding", workspaceId: a.workspaceId ?? "", projectId: a.projectId,
    provider: a.llmConfig.provider, model: a.llmConfig.model, baseUrl: a.llmConfig.baseUrl,
  });
  const observed = observedFiles.get(a.sessionId) ?? new Set<string>();
  observedFiles.set(a.sessionId, observed);
  const role = a.role ?? "default";

  const tools = await buildToolset({
    surface: chat ? "chat" : role === "automation-dev" ? "automation-dev" : "coding",
    // Develop sessions edit scripts only: no Cairn data tools.
    cairn: role === "automation-dev" ? undefined : {
      exclude: chat ? new Set<string>(CHAT_EXCLUDED_TOOLS) : undefined,
      getDb: () => a.ctx.db,
      req: { message: a.prompt, threadId: a.sessionId, projectId: a.projectId, workspaceId: a.workspaceId, config: { baseUrl: a.llmConfig.baseUrl, model: a.llmConfig.model, apiKey: a.llmConfig.apiKey } },
      workspacePath: a.ctx.workspacePath,
      llmConfig: { baseUrl: a.llmConfig.baseUrl, model: a.llmConfig.model, apiKey: a.llmConfig.apiKey } as never,
      getWin: a.ctx.getWin,
      askQuestions: (questions, tool) => new Promise((resolve, reject) => {
        const nonce = randomBytes(16).toString("hex");
        pendingQuestions.set(qKey(a.sessionId, tool.callId), { nonce, resolve: (answers) => { try { resolve(JSON.parse(answers)); } catch { resolve(answers); } }, reject });
        tool.signal?.addEventListener("abort", () => { if (pendingQuestions.delete(qKey(a.sessionId, tool.callId))) reject(new Error("cancelled")); }, { once: true });
        broadcastEvent("session:projection", makeSessionProjection(a.sessionId, "question", { callId: tool.callId, questions, nonce }));
      }),
    },
    external: role === "automation-dev" || !a.workspaceId ? undefined : { db: a.ctx.db, workspaceId: a.workspaceId, projectId: a.projectId ?? "" },
    fs: { cwd: a.cwd, rgPath, observed },
    onTodos: (todos) => broadcastEvent("session:projection", makeSessionProjection(a.sessionId, "todos", { todos })),
  });

  try {
    await h.prompt({
      sessionId: a.sessionId,
      prompt: a.prompt,
      cwd: a.cwd,
      profile: chatProfile?.profile ?? engineProfile(a.llmConfig.mode, role),
      route: routeFromConfig(a.llmConfig),
      systemPrompt: a.systemPrompt,
      tools,
      reasoningEffort: a.llmConfig.reasoningEffort,
      temperature: a.llmConfig.temperature,
      maxSteps: a.llmConfig.maxSteps,
    });
    broadcastEvent("db:changed", null);
  } catch (err) {
    const busy = err instanceof Error && /busy/.test(err.message);
    broadcastEvent("session:projection", makeSessionProjection(a.sessionId, "error", { message: err instanceof Error ? err.message : String(err), code: busy ? "already-running" : undefined }));
    if (busy) broadcastEvent("session:busy", { sessionId: a.sessionId, reason: "already-running" });
  }
}

/** A chat turn on the engine. Mirrors the checks `runChatPrompt` makes before it starts. */
export async function runEngineChat(ctx: DbContext, req: ChatRequest): Promise<void> {
  const sessionId = `chat-${req.threadId}`;
  const h = getEngineHost(ctx);
  if (h.isRunning(sessionId)) {
    broadcastEvent("session:projection", makeSessionProjection(sessionId, "error", { message: "Session is busy — please wait for the current turn to finish.", code: "already-running" }));
    broadcastEvent("session:busy", { sessionId, reason: "already-running" });
    return;
  }
  // Lazy: chat.ts pulls in the pop-out window module, which needs a live Electron `app` at import time.
  const { resolveAIConfig } = await import("./chat");
  const { provider, baseUrl, model, apiKey } = resolveAIConfig(req.config);
  if (!apiKey && !isLocalEndpoint(baseUrl)) {
    broadcastEvent("session:projection", makeSessionProjection(sessionId, "error", { message: "Missing API key — configure provider in Settings.", code: "missing-api-key" }));
    broadcastEvent("session:busy", { sessionId, reason: "missing-api-key" });
    return;
  }
  const policy = chatApprovalPolicyFor(req);
  await runEnginePrompt({
    ctx, sessionId, prompt: req.message, cwd: ctx.workspacePath,
    projectId: req.projectId, workspaceId: req.workspaceId,
    systemPrompt: chatSystemPrompt(req, policy),
    llmConfig: {
      baseUrl, model, apiKey, provider,
      maxSteps: req.config?.maxSteps ?? 30,
      temperature: req.config?.temperature,
      maxTokens: req.config?.maxTokens,
      contextWindow: req.config?.contextLimit ?? req.config?.contextWindow,
      reasoningEffort: req.config?.reasoningEffort,
      isReasoningModel: req.config?.isReasoningModel,
      apiMode: req.config?.apiMode,
    } as AgentLLMConfig,
    chat: { req, policy },
  });
}
