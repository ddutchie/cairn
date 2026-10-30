/**
 * Bridge between the session IPC handlers and the Cairn-owned agent engine
 * (electron/agent). Sessions the retired engine harness wrote are imported on first touch.
 */
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import os from "node:os";
import * as electron from "electron";
import { rgPath } from "@vscode/ripgrep";
import type { DbContext } from "./result-helpers";
import { broadcastEvent } from "./registry";
import { AgentHost, type HostSend } from "../agent/host";
import type { AgentTool } from "../agent/tools";
import type { SubagentDeps } from "../agent/tools/subagent";
import type { ModelRoute } from "../agent/provider";
import { prepareAttachments, type Attachment } from "../agent/attachments";
import { updateCodingSession } from "../db/sessions-queries";
import type { Profile } from "../agent/loop";
import type { Mode as EngineMode } from "../agent/policy";

import { canonicalCommand, presetRules, type Rule } from "../agent/rules";
import { buildToolset } from "../agent/tools/index";
import { JobRegistry } from "../agent/jobs";
import { createHooks } from "../agent/hooks";
import { LspManager } from "../agent/lsp";
import { sharedPtyAdapter, TerminalRegistry } from "../agent/terminals";
import { importLegacySession } from "../agent/session/legacy-import";
import { isLocalEndpoint } from "../lib/llm";
import { createHostStore, getSandboxMode, isScheduleEnabled, recordUsage } from "../agent/host-store";
import { listSessionIdsForWorkspace } from "../db/workspace-queries";
import { indexSessions, runtimeEmbed, searchSessionsSemantic, type SessionIndexDeps } from "../agent/session-search";
import { getEmbeddingsSettingsCached } from "../lib/config-cache";
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

export const PLAN_MODE_PROMPT = `## Plan mode
You are in plan mode: everything you can do is read-only. Investigate the code and the project, then write a complete plan in markdown (goal, approach, and a \`## Tasks\` checklist of \`- [ ]\` items). Present it by calling \`exit_plan_mode\` with the full plan, then stop and wait. Do not start the work until the user approves it.`;

// ── permission presets (per session) ─────────────────────────────────────

export const PERMISSION_PRESETS = [
  { value: "ask", name: "Ask", description: "Ask before anything that changes files, runs commands, or calls external tools." },
  { value: "yolo", name: "Allow all", description: "Run everything without asking, except external tool calls, which still ask." },
] as const;
type PermissionPreset = typeof PERMISSION_PRESETS[number]["value"];
const sessionPreset = new Map<string, PermissionPreset>();

/** The legacy approval mode a session would start with, as a preset. */
const presetFromMode = (mode: Mode | undefined): PermissionPreset => (mode === "auto" ? "yolo" : "ask");

function presetProfile(sessionId: string, mode: Mode | undefined, role: "default" | "automation-dev" | undefined): Profile {
  const preset = sessionPreset.get(sessionId);
  const base = engineProfile(mode, role);
  if (!preset || base.mode === "plan") return base;
  return { ...base, mode: preset === "yolo" ? "yolo" : "ask", externalAlwaysAsks: preset === "yolo" };
}

export function readEnginePermissions(sessionId: string, fallback: Mode | undefined): { options: Array<{ value: string; name: string; description?: string }>; currentValue: string } {
  return { options: PERMISSION_PRESETS.map((p) => ({ ...p })), currentValue: sessionPreset.get(sessionId) ?? presetFromMode(fallback) };
}

export function setEnginePermission(sessionId: string, preset: string, fallback: Mode | undefined): { options: Array<{ value: string; name: string; description?: string }>; currentValue: string } {
  if (!PERMISSION_PRESETS.some((p) => p.value === preset)) throw Object.assign(new Error(`Unknown permission preset: ${preset}`), { code: "bad-request" });
  sessionPreset.set(sessionId, preset as PermissionPreset);
  const view = readEnginePermissions(sessionId, fallback);
  broadcastEvent("session:projection", makeSessionProjection(sessionId, "permissions", view));
  return view;
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
const sessionTaps = new Map<string, HostSend>();
interface UsageMeta { source: "chat" | "coding" | "automation" | "writing-style"; workspaceId: string; projectId?: string; provider?: string; model: string; baseUrl: string }
const usageMeta = new Map<string, UsageMeta>();
const observedFiles = new Map<string, Set<string>>();

interface PendingQuestion { nonce: string; questions: unknown; resolve(answers: string): void; reject(err: Error): void }
const pendingQuestions = new Map<string, PendingQuestion>();
const qKey = (sessionId: string, callId: string) => `${sessionId}::${callId}`;

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
const getLsp = () => (lspManager ??= new LspManager());

let terminalRegistry: TerminalRegistry | undefined;
function getTerminals(ctx: DbContext): TerminalRegistry {
  terminalRegistry ??= new TerminalRegistry(() => sharedPtyAdapter(ctx.db));
  return terminalRegistry;
}

export function getEngineHost(ctx: DbContext): AgentHost {
  hostCtx = ctx;
  host ??= new AgentHost({
    root: hostRoot(),
    beforeOpen: adoptLegacySession,
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
  const has = async () => (await h.title(sessionId).catch(() => null)) !== null || (await h.loadMessages(sessionId).then((m) => m.messages.length > 0, () => false));
  if (await has()) return true;
  await adoptLegacySession(sessionId);
  return has();
}

export function answerQuestion(sessionId: string, callId: string, nonce: string | undefined, answers: string): boolean {
  const pending = pendingQuestions.get(qKey(sessionId, callId));
  if (!pending || !nonce || pending.nonce !== nonce) return false;
  pendingQuestions.delete(qKey(sessionId, callId));
  pending.resolve(answers);
  return true;
}

/** Outstanding question asks, so a reloading renderer can re-open the card. */
export function listPendingQuestions(sessionId: string): Array<{ callId: string; questions: never; nonce: string }> {
  const prefix = `${sessionId}::`;
  return [...pendingQuestions].filter(([k]) => k.startsWith(prefix)).map(([k, p]) => ({ callId: k.slice(prefix.length), questions: p.questions as never, nonce: p.nonce }));
}

export function cancelQuestions(sessionId: string): void {
  for (const [key, p] of [...pendingQuestions]) {
    if (key.startsWith(`${sessionId}::`)) { pendingQuestions.delete(key); p.reject(new Error("cancelled")); }
  }
}

export interface EnginePromptArgs {
  ctx: DbContext;
  /** Confine shell commands even when the user turned the sandbox off (unattended runs). */
  forceSandbox?: boolean;
  /** No human is watching: don't offer ask_questions. */
  noQuestions?: boolean;
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
  /** Staged images/PDFs for this prompt. */
  attachments?: readonly Attachment[];
  /** Coding sessions: "plan" is read-only and ends in `exit_plan_mode`. */
  sessionMode?: "plan" | "execute";
  /** Headless runs: tools added to the surface toolset, and the usage row's source. */
  extraTools?: readonly AgentTool[];
  usageSource?: "automation" | "writing-style";
  /** Run with exactly these tools (by name), whatever the surface offers. */
  allowTools?: ReadonlySet<string>;
  /** Skip the user's prompt/tool hooks (internal one-off runs). */
  noHooks?: boolean;
  profile?: Profile;
  signal?: AbortSignal;
}

/** First native use of a session that only exists as a engine log: bring its history over. */
async function adoptLegacySession(sessionId: string): Promise<void> {
  try {
    await importLegacySession(legacyRoot(), hostRoot(), sessionId);
  } catch (err) {
    console.warn(`[agent] legacy import skipped for ${sessionId}:`, err instanceof Error ? err.message : err);
  }
}

/** Where the retired engine harness kept its logs; read only to bring old history over. */
export function legacyRoot(): string {
  let base: string;
  try { base = electron.app.getPath("userData"); } catch { base = os.tmpdir(); }
  return path.join(base, "sessions");
}

/**
 * Remove retired-harness logs whose directory name matches, so a cleared or deleted session is not
 * re-imported on next touch. Looks one level below each project directory (`<root>/<project>/<id>`).
 */
export function removeLegacySessions(match: (name: string) => boolean): void {
  const root = legacyRoot();
  let projects: string[];
  try { projects = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { return; }
  for (const project of projects) {
    let names: string[];
    try { names = fs.readdirSync(path.join(root, project)); } catch { continue; }
    for (const name of names) {
      if (!match(name)) continue;
      try { fs.rmSync(path.join(root, project, name), { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }
}

/** Native session logs live beside the legacy ones; a missing Electron `app` (unit tests) falls back to tmp. */
export function hostRoot(): string {
  let base: string;
  try { base = electron.app.getPath("userData"); } catch { base = os.tmpdir(); }
  return path.join(base, "sessions-native");
}

// ── subagents ────────────────────────────────────────────────────────────

const SUBAGENT_PROMPT = "\n\n## Subagent\nYou are a subagent working for another agent. Do the task you were given and finish with a concise report of what you found or did. You cannot start further subagents.";

/** What a child needs from its parent, kept after the turn so the human can message a child later. */
interface SpawnContext {
  cwd: string;
  profile: Profile;
  route: ModelRoute;
  systemPrompt: string;
  tools: readonly AgentTool[];
  reasoningEffort?: string;
  temperature?: number;
  maxSteps?: number;
}
const spawnContexts = new Map<string, SpawnContext>();

function controlError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function subagentDeps(ctx: DbContext): SubagentDeps {
  const host = () => getEngineHost(ctx);
  return {
    run: async (parent, req) => {
      const sc = spawnContexts.get(parent);
      if (!sc) throw controlError("parent-unavailable", "Subagents are unavailable for this session.");
      const childId = req.childId ?? `${parent}.sub-${randomBytes(4).toString("hex")}`;
      const meta = usageMeta.get(parent);
      if (meta) usageMeta.set(childId, meta);
      sessionRules.set(childId, sessionRules.get(parent) ?? []);
      const workspaceId = sessionWorkspace.get(parent);
      if (workspaceId) sessionWorkspace.set(childId, workspaceId);
      const out = await host().prompt({
        sessionId: childId, parentSession: parent, prompt: req.prompt, cwd: sc.cwd, profile: sc.profile, route: sc.route,
        systemPrompt: `${sc.systemPrompt}${SUBAGENT_PROMPT}`, tools: sc.tools, reasoningEffort: sc.reasoningEffort,
        temperature: sc.temperature, maxSteps: sc.maxSteps, signal: req.signal,
      });
      return { childId, ...out };
    },
    list: (parent) => host().listChildren(parent),
    interrupt: (parent, childId) => {
      if (!childId.startsWith(`${parent}.sub-`) || !host().isRunning(childId)) return false;
      host().abort(childId);
      return true;
    },
    transcript: (parent) => host().transcript(parent),
  };
}

/** The subagent catalog for the header popover. Children only: delegation is one level deep. */
/** Drop what a closed or cleared session left in memory. */
/** Snapshots for the goal chip, the alarm pill and the jobs dock. */
export async function readEngineGoal(ctx: DbContext, sessionId: string) {
  const g = await getEngineHost(ctx).readGoal(sessionId);
  return g ? { ...g, blockedReason: g.blockedReason ? { code: "blocked", message: g.blockedReason } : undefined } : null;
}

export async function listEngineSchedules(ctx: DbContext, sessionId: string) {
  const now = Date.now();
  return (await getEngineHost(ctx).readSchedules(sessionId)).map((s) => ({ id: s.id, prompt: s.prompt, scheduledAt: s.at, kind: s.kind, state: Date.parse(s.at) < now ? "overdue" as const : "scheduled" as const }));
}

export function forgetEngineSession(sessionId: string): void {
  jobRegistry?.killAll(sessionId);
  terminalRegistry?.closeAll(sessionId);
  for (const id of [...spawnContexts.keys()]) if (id === sessionId || id.startsWith(`${sessionId}.sub-`)) spawnContexts.delete(id);
}

/** Quit: stop running turns, their jobs and terminals, and any language servers. */
export async function shutdownEngine(): Promise<void> {
  for (const id of host?.runningIds() ?? []) { host?.abort(id); forgetEngineSession(id); }
  // Jobs and terminals outlive their turn, so idle sessions' ones must be stopped too.
  jobRegistry?.killEvery();
  terminalRegistry?.closeEvery();
  lspManager?.disposeAll();
  await import("../lib/mcp-client").then((m) => m.disposeAll()).catch(() => undefined);
}

export async function listEngineSubagents(ctx: DbContext, parent: string): Promise<{ entries: Array<{ id: string; mode: "continuable"; label: string; activity: "running" | "inactive"; live: boolean; hasChildren: boolean }>; parentAvailable: boolean }> {
  const children = await getEngineHost(ctx).listChildren(parent);
  return {
    entries: children.map((c) => ({ id: c.id, mode: "continuable" as const, label: c.label, activity: c.running ? "running" as const : "inactive" as const, live: c.running, hasChildren: false })),
    parentAvailable: spawnContexts.has(parent),
  };
}

export function interruptEngineSubagent(ctx: DbContext, parent: string, childId: string): { accepted: true } {
  subagentDeps(ctx).interrupt(parent, childId);
  return { accepted: true };
}

/** A human follow-up to a finished child. Runs in the background; the trace shows the reply. */
export async function messageEngineSubagent(ctx: DbContext, parent: string, childId: string, text: string): Promise<{ messageId: string }> {
  const deps = subagentDeps(ctx);
  if (!spawnContexts.has(parent)) throw controlError("parent-unavailable", "Send the session a prompt first; its subagents can be messaged once it is running again.");
  const known = (await deps.list(parent)).find((c) => c.id === childId);
  if (!known) throw controlError("bad-request", "Unknown subagent.");
  if (known.running) throw controlError("delivery-unavailable", "The subagent is still working.");
  void deps.run(parent, { childId, prompt: text }).catch((err) => console.warn("[agent] subagent message failed:", err instanceof Error ? err.message : err));
  return { messageId: childId };
}

/** Where session vectors go; undefined when the user has not turned embeddings on. */
async function sessionIndexDeps(db: DbContext["db"], workspaceId: string): Promise<SessionIndexDeps | undefined> {
  const settings = getEmbeddingsSettingsCached();
  if (!settings?.enabled) return undefined;
  // Lazy: the embeddings client reads Electron's `app` paths at import time.
  const model = settings.modelId || (await import("../embeddings/client")).getDefaultModelId();
  return { db, root: hostRoot(), workspaceId, model, embed: runtimeEmbed };
}

export async function runEnginePrompt(a: EnginePromptArgs): Promise<void> {
  try {
    await runEnginePromptInner(a);
  } catch (err) {
    // Setup failed before the turn started (toolset, attachments, route): surface it instead of a dangling spinner.
    reportPromptError(a.sessionId, err);
  }
}

/** Error projection to the run's tap when it has one (automations), else the renderer. */
function reportPromptError(sessionId: string, err: unknown): void {
  const busy = err instanceof Error && /busy/.test(err.message);
  const projection = makeSessionProjection(sessionId, "error", { message: err instanceof Error ? err.message : String(err), code: busy ? "already-running" : undefined });
  const tap = sessionTaps.get(sessionId);
  if (tap) tap("session:projection", projection as never); else broadcastEvent("session:projection", projection);
  if (busy) broadcastEvent("session:busy", { sessionId, reason: "already-running" });
}

async function runEnginePromptInner(a: EnginePromptArgs): Promise<void> {
  const h = getEngineHost(a.ctx);
  await adoptLegacySession(a.sessionId);
  if (a.workspaceId) sessionWorkspace.set(a.sessionId, a.workspaceId);
  const chat = a.chat;
  // The session list, pop-out and session search key off these rows; the engine owns writing them now.
  try {
    const store = createHostStore(a.ctx.db);
    store.upsertSessionProfile(a.sessionId, chat ? "chat" : a.role === "automation-dev" ? "automation-dev" : "coding", { cwd: a.cwd, workspaceId: a.workspaceId, projectId: a.projectId });
    if (chat && a.workspaceId) store.indexChatThread(a.sessionId.replace(/^chat-/, ""), a.workspaceId, a.projectId);
  } catch (err) { console.warn("[agent] could not record session profile:", err instanceof Error ? err.message : err); }
  const chatProfile = chat ? chatEngineProfile(chat.policy) : undefined;
  sessionRules.set(a.sessionId, chatProfile?.rules ?? []);
  usageMeta.set(a.sessionId, {
    source: a.usageSource ?? (chat ? "chat" : "coding"), workspaceId: a.workspaceId ?? "", projectId: a.projectId,
    provider: a.llmConfig.provider, model: a.llmConfig.model, baseUrl: a.llmConfig.baseUrl,
  });
  const observed = observedFiles.get(a.sessionId) ?? new Set<string>();
  observedFiles.set(a.sessionId, observed);
  const role = a.role ?? "default";
  const planning = a.sessionMode === "plan" && !chat && role === "default";
  const prepared = prepareAttachments(a.prompt, a.attachments);

  let mcpInstructions = "";
  const tools = await buildToolset({
    onInstructions: (text) => { mcpInstructions = text; },
    surface: chat ? "chat" : role === "automation-dev" ? "automation-dev" : "coding",
    // Develop sessions edit scripts only: no Cairn data tools.
    cairn: role === "automation-dev" ? undefined : {
      exclude: chat ? new Set<string>(CHAT_EXCLUDED_TOOLS) : undefined,
      getDb: () => a.ctx.db,
      req: { message: a.prompt, threadId: a.sessionId, projectId: a.projectId, workspaceId: a.workspaceId, config: { baseUrl: a.llmConfig.baseUrl, model: a.llmConfig.model, apiKey: a.llmConfig.apiKey } },
      workspacePath: a.ctx.workspacePath,
      llmConfig: { baseUrl: a.llmConfig.baseUrl, model: a.llmConfig.model, apiKey: a.llmConfig.apiKey } as never,
      getWin: a.ctx.getWin,
      askQuestions: a.noQuestions ? undefined : (questions, tool) => new Promise((resolve, reject) => {
        const nonce = randomBytes(16).toString("hex");
        pendingQuestions.set(qKey(a.sessionId, tool.callId), { nonce, questions, resolve: (answers) => { try { resolve(JSON.parse(answers)); } catch { resolve(answers); } }, reject });
        tool.signal?.addEventListener("abort", () => { if (pendingQuestions.delete(qKey(a.sessionId, tool.callId))) reject(new Error("cancelled")); }, { once: true });
        broadcastEvent("session:projection", makeSessionProjection(a.sessionId, "question", { callId: tool.callId, questions, nonce }));
      }),
    },
    external: role === "automation-dev" || !a.workspaceId ? undefined : { db: a.ctx.db, workspaceId: a.workspaceId, projectId: a.projectId ?? "" },
    fs: { cwd: a.cwd, rgPath, observed, sandbox: () => ({ mode: a.forceSandbox ? "workspace-write" : getSandboxMode() }), jobs: { registry: getJobRegistry(), owner: a.sessionId } },
    jobs: { registry: getJobRegistry(), owner: a.sessionId },
    sessions: role === "automation-dev" || !a.workspaceId ? undefined : {
      root: hostRoot(), currentSession: a.sessionId,
      workspaceSessionIds: () => new Set(listSessionIdsForWorkspace(a.ctx.db, a.workspaceId!)),
      semantic: async (query, limit) => {
        const idx = await sessionIndexDeps(a.ctx.db, a.workspaceId!);
        if (!idx) return null;
        const allowed = new Set(listSessionIdsForWorkspace(a.ctx.db, a.workspaceId!));
        allowed.delete(a.sessionId);
        return searchSessionsSemantic(idx, allowed, query, limit);
      },
    },
    lsp: role === "automation-dev" ? undefined : { manager: getLsp(), cwd: a.cwd },
    terminals: role === "automation-dev" ? undefined : { registry: getTerminals(a.ctx), owner: a.sessionId, cwd: a.cwd },
    goal: {
      get: () => h.goal(a.sessionId),
      create: (objective, maxRounds) => h.createGoal(a.sessionId, objective, maxRounds),
      update: (patch) => h.updateGoal(a.sessionId, patch),
    },
    // Session reminders are opt-in (Settings → Agent).
    schedule: !isScheduleEnabled() ? undefined : {
      list: () => h.schedules(a.sessionId),
      add: (prompt, at, kind) => h.addSchedule(a.sessionId, prompt, at, kind),
      cancel: (id) => h.cancelSchedule(a.sessionId, id),
    },
    onTodos: (todos) => broadcastEvent("session:projection", makeSessionProjection(a.sessionId, "todos", { todos })),
    subagents: chat && !chat.req.useSubagents ? undefined : subagentDeps(a.ctx),
    plan: planning ? {
      onPlan: (sessionId, plan) => {
        try { updateCodingSession(a.ctx.db, sessionId, { planContent: plan }); } catch (err) { console.warn("[agent] failed to persist plan:", err); }
        broadcastEvent("session:projection", makeSessionProjection(sessionId, "plan-note", { planContent: plan }));
      },
    } : undefined,
  });

  if (a.extraTools?.length) tools.push(...a.extraTools);
  if (a.allowTools) { const keep = tools.filter((t) => a.allowTools!.has(t.name)); tools.length = 0; tools.push(...keep); }
  const profile = a.profile ?? (planning ? { id: "coding", interactive: true, mode: "plan" } as Profile : undefined) ?? chatProfile?.profile ?? presetProfile(a.sessionId, a.llmConfig.mode, role);
  const route = routeFromConfig(a.llmConfig);
  const systemPrompt = [a.systemPrompt, planning ? PLAN_MODE_PROMPT : "", mcpInstructions].filter(Boolean).join("\n\n");
  const subagentToolNames = new Set(["subagent", "delegate", "workflow", "ralph", "send_message", "list_agents", "interrupt_agent", "exit_plan_mode"]);
  spawnContexts.set(a.sessionId, {
    cwd: a.cwd, profile, route, systemPrompt, tools: tools.filter((t) => !subagentToolNames.has(t.name)),
    reasoningEffort: a.llmConfig.reasoningEffort, temperature: a.llmConfig.temperature, maxSteps: a.llmConfig.maxSteps,
  });
  const onAbort = () => h.abort(a.sessionId);
  if (a.signal?.aborted) onAbort(); else a.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    await h.prompt({
      sessionId: a.sessionId,
      prompt: prepared.text,
      images: prepared.images,
      hooks: role === "automation-dev" || a.noHooks ? undefined : createHooks({ sessionId: a.sessionId, cwd: a.cwd }),
      cwd: a.cwd,
      profile,
      route,
      systemPrompt,
      tools,
      reasoningEffort: a.llmConfig.reasoningEffort,
      temperature: a.llmConfig.temperature,
      maxSteps: a.llmConfig.maxSteps,
    });
    broadcastEvent("db:changed", null);
    // Keep the meaning index current for search_sessions; best effort and off the critical path.
    const idx = a.workspaceId && !a.noHooks && role !== "automation-dev" ? await sessionIndexDeps(a.ctx.db, a.workspaceId) : undefined;
    if (idx) void indexSessions(idx, [a.sessionId]).catch((err) => console.warn("[agent] session index skipped:", err instanceof Error ? err.message : err));
  } catch (err) {
    reportPromptError(a.sessionId, err);
  } finally {
    a.signal?.removeEventListener("abort", onAbort);
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
    ctx, sessionId, prompt: req.message, cwd: ctx.workspacePath, attachments: req.images as Attachment[] | undefined,
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

export interface EngineAutomationArgs extends Omit<EnginePromptArgs, "chat" | "role" | "usageSource" | "profile"> {
  /** Every event and projection of the run goes here instead of to the renderer. */
  tap: HostSend;
  /** Unattended mode: `yolo` when approvals are automatic, otherwise every ask reaches the tap. */
  autoApprove: boolean;
}

/** A headless coding run (automations): same engine and tools, events delivered to `tap` only. */
export async function runEngineAutomation(a: EngineAutomationArgs): Promise<void> {
  sessionTaps.set(a.sessionId, a.tap);
  try {
    await runEnginePrompt({
      ...a,
      usageSource: "automation",
      forceSandbox: true,
      noQuestions: true,
      profile: { id: "automation", interactive: true, mode: a.autoApprove ? "yolo" : "ask", externalAlwaysAsks: a.autoApprove },
    });
  } finally {
    sessionTaps.delete(a.sessionId);
    // Nothing will clear an unattended run later: stop what it left running and drop its in-memory state.
    forgetEngineSession(a.sessionId);
    host?.release(a.sessionId);
  }
}

/** A run whose events go to `tap` instead of the renderer (internal wizards). */
export async function runEngineTapped(a: Omit<EnginePromptArgs, "role" | "profile"> & { tap: HostSend }): Promise<void> {
  sessionTaps.set(a.sessionId, a.tap);
  try {
    await runEnginePrompt(a);
  } finally {
    sessionTaps.delete(a.sessionId);
  }
}

/** Answer an ask raised by a headless run. */
export function respondEngineAsk(ctx: DbContext, sessionId: string, callId: string, nonce: string | undefined, decision: { approved: boolean; grant?: "session" | "command" | "workspace" }): boolean {
  return getEngineHost(ctx).respondTool(sessionId, callId, nonce, decision);
}

/** `/compact`: fold the older history of a coding or chat session now. */
export async function compactEngineSession(ctx: DbContext, args: { sessionId: string; cwd: string; llmConfig: AgentLLMConfig }): Promise<"compacted" | "nothing" | "busy"> {
  const h = getEngineHost(ctx);
  if (h.isRunning(args.sessionId)) return "busy";
  broadcastEvent("session:projection", makeSessionProjection(args.sessionId, "compact", { status: "start" }));
  try {
    return (await h.compact(args.sessionId, args.cwd, routeFromConfig(args.llmConfig))) ? "compacted" : "nothing";
  } catch (err) {
    broadcastEvent("session:projection", makeSessionProjection(args.sessionId, "compact", { status: "end" }));
    throw err;
  }
}
