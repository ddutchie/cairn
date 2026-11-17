/**
 * Prompt assembly and the coding-session turn. (F5/B4: split out of
 * `electron/ipc/engine-bridge.ts`; no logic changes.)
 */
import type { RunSetup } from "../../../shared/types/automations";
import { randomBytes } from "node:crypto";
import { rgPath } from "@vscode/ripgrep";
import type { DbContext } from "../result-helpers";
import { broadcastEvent } from "../registry";
import { SessionBusyError } from "../../agent/host";
import type { AgentTool } from "../../agent/tool-types";
import { prepareAttachments, type Attachment } from "../../agent/attachments";
import { updateCodingSession } from "../../db/sessions-queries";
import type { Profile } from "../../agent/loop";
import { buildToolset, skillCatalog } from "../../agent/tools/index";
import { createHooks } from "../../agent/hooks";
import { getEngineHost, getJobRegistry, getLsp, getTerminals } from "./host";
import { createHostStore, getSandboxMode, isScheduleEnabled } from "../../agent/host-store";
import { listSessionIdsForWorkspace } from "../../db/workspace-queries";
import { indexSessions, runtimeEmbed, searchSessionsSemantic, type SessionIndexDeps } from "../../agent/session-search";
import { getEmbeddingsSettingsCached } from "../../lib/config-cache";
import { CHAT_EXCLUDED_TOOLS } from "../../lib/tool-schemas";
import type { ChatRequest } from "../../lib/chat-prompt";
import { routeFromConfig } from "../../agent/route";
import type { AgentLLMConfig } from "../../lib/session-runtime-types";
import type { ChatApprovalPolicy } from "../../../shared/agent/chat-approval";
import { makeSessionProjection } from "../../../shared/agent/session-projection";
import { failedTurnEnd } from "../../agent/session/adapter";
import { rejectBusy } from "../session-guards";
import { adoptLegacySession, hostRoot } from "./legacy-sessions";
import { presetProfile } from "./permissions";
import { chatEngineProfile } from "../../agent/profiles";
import { subagentDeps } from "./subagents";
import { askSessionQuestion, takeSessionQuestion } from "./questions";
import { ensureSessionState, getSessionState } from "./session-state";

/** Sent with each plan-mode prompt, not in the system prompt, so approving the plan leaves the cached prefix intact. */
export const PLAN_MODE_PROMPT = `## Plan mode
You are in plan mode: everything you can do is read-only (shell commands run in a read-only sandbox, so they can inspect but not change anything). Investigate the code and the project, then write a complete plan in markdown (goal, approach, and a \`## Tasks\` checklist of \`- [ ]\` items). Present it by calling \`exit_plan_mode\` with the full plan, then stop and wait. Do not start the work until the user approves it.`;

export const PLAN_MODE_ENDED = `## Plan mode is off
You are no longer in plan mode: you can change files and run commands again, subject to the usual approvals.`;

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
  /** Model-only context for this prompt only; the logged prompt stays what was asked. */
  context?: string;
  /** Model-only context kept visible across the session (see `PromptRequest.standingContext`). */
  standingContext?: readonly string[];
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
  usageSource?: "automation" | "writing-style" | "today";
  /** Run with exactly these tools (by name), whatever the surface offers. */
  allowTools?: ReadonlySet<string>;
  /** Connector scope when it differs from `projectId`: Today reads every included project's connectors. */
  externalProjectIds?: readonly string[];
  /** Connectors left out of the scope by id (apps turned off for Today): never connected or offered. */
  externalExclude?: readonly string[];
  /** Cut each connector result to this many characters (Today). */
  externalResultChars?: number;
  /** Run connector calls in one step at the same time (Today: read-only, every ask decided by the run). */
  externalParallel?: boolean;
  /** Headless runs: keep only the tools this returns true for (Today's read-only toolset). */
  toolFilter?: (name: string) => boolean;
  /** Called once the run is assembled, with what is sent: for run logs and debug exports. */
  onSetup?: (setup: RunSetup) => void;
  /** Skip the user's prompt/tool hooks (internal one-off runs). */
  noHooks?: boolean;
  profile?: Profile;
  signal?: AbortSignal;
}

/** Where session vectors go; undefined when the user has not turned embeddings on. */
async function sessionIndexDeps(db: DbContext["db"], workspaceId: string): Promise<SessionIndexDeps | undefined> {
  const settings = getEmbeddingsSettingsCached();
  if (!settings?.enabled) return undefined;
  // Lazy: the embeddings client reads Electron's `app` paths at import time.
  const model = settings.modelId || (await import("../../embeddings/client")).getDefaultModelId();
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
  const message = err instanceof Error ? err.message : String(err);
  const tap = getSessionState(sessionId)?.tap;
  // "Busy" means another turn is live: it will send its own turn/end, so this must not.
  if (err instanceof SessionBusyError) {
    rejectBusy(sessionId, message, "already-running", tap as ((channel: string, payload: unknown) => void) | undefined);
    return;
  }
  const projection = makeSessionProjection(sessionId, "error", { message });
  const event = { sessionId, event: failedTurnEnd(message) };
  if (tap) { tap("session:projection", projection as never); tap("session:event", event as never); return; }
  broadcastEvent("session:projection", projection);
  broadcastEvent("session:event", event);
}

async function runEnginePromptInner(a: EnginePromptArgs): Promise<void> {
  const h = getEngineHost(a.ctx);
  await adoptLegacySession(a.sessionId);
  const st = ensureSessionState(a.sessionId);
  if (a.workspaceId) st.workspaceId = a.workspaceId;
  const chat = a.chat;
  // The session list, pop-out and session search key off these rows; the engine owns writing them now.
  try {
    const store = createHostStore(a.ctx.db);
    store.upsertSessionProfile(a.sessionId, chat ? "chat" : a.role === "automation-dev" ? "automation-dev" : "coding", { cwd: a.cwd, workspaceId: a.workspaceId, projectId: a.projectId });
    if (chat && a.workspaceId) store.indexChatThread(a.sessionId.replace(/^chat-/, ""), a.workspaceId, a.projectId);
  } catch (err) { console.warn("[agent] could not record session profile:", err instanceof Error ? err.message : err); }
  const chatProfile = chat ? chatEngineProfile(chat.policy) : undefined;
  st.rules = chatProfile?.rules ?? [];
  st.usage = {
    source: a.usageSource ?? (chat ? "chat" : "coding"), workspaceId: a.workspaceId ?? "", projectId: a.projectId,
    provider: a.llmConfig.provider, model: a.llmConfig.model, baseUrl: a.llmConfig.baseUrl,
  };
  const observed = (st.observed ??= new Set<string>());
  const role = a.role ?? "default";
  const planning = a.sessionMode === "plan" && !chat && role === "default";
  const prepared = prepareAttachments(a.prompt, a.attachments);

  let mcpInstructions = "";
  let tools = await buildToolset({
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
        askSessionQuestion(a.sessionId, tool.callId, nonce, questions, (answers) => { try { resolve(JSON.parse(answers)); } catch { resolve(answers); } }, reject);
        tool.signal?.addEventListener("abort", () => { if (takeSessionQuestion(a.sessionId, tool.callId)) reject(new Error("cancelled")); }, { once: true });
        broadcastEvent("session:projection", makeSessionProjection(a.sessionId, "question", { callId: tool.callId, questions, nonce }));
      }),
    },
    external: role === "automation-dev" || !a.workspaceId ? undefined : { db: a.ctx.db, workspaceId: a.workspaceId, projectId: a.externalExclude?.length ? { projects: a.externalProjectIds ?? [a.projectId ?? ""], exclude: a.externalExclude } : a.externalProjectIds ?? a.projectId ?? "", maxResultChars: a.externalResultChars, parallel: a.externalParallel },
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
    terminals: role === "automation-dev" ? undefined : { registry: getTerminals(a.ctx), owner: a.sessionId, cwd: a.cwd, ...(a.forceSandbox ? { sandbox: "workspace-write" as const } : {}) },
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
    // A subagent keeps its own checklist; only the session's own list is shown.
    onTodos: (todos, sessionId) => { if (sessionId === a.sessionId) broadcastEvent("session:projection", makeSessionProjection(a.sessionId, "todos", { todos })); },
    subagents: chat && !chat.req.useSubagents ? undefined : subagentDeps(a.ctx),
    // Always registered on a coding session so the tool list is the same in and out of plan mode.
    plan: !chat && role === "default" ? {
      active: () => planning,
      onPlan: (sessionId, plan) => {
        try { updateCodingSession(a.ctx.db, sessionId, { planContent: plan }); } catch (err) { console.warn("[agent] failed to persist plan:", err); }
        broadcastEvent("session:projection", makeSessionProjection(sessionId, "plan-note", { planContent: plan }));
      },
    } : undefined,
  });

  if (a.extraTools?.length) tools.push(...a.extraTools);
  if (a.allowTools) tools = tools.filter((t) => a.allowTools!.has(t.name));
  if (a.toolFilter) tools = tools.filter((t) => a.toolFilter!(t.name));
  const profile = a.profile ?? (planning ? { id: "coding", interactive: true, mode: "plan" } as Profile : undefined) ?? chatProfile?.profile ?? presetProfile(a.sessionId, a.llmConfig.mode, role);
  const route = routeFromConfig(a.llmConfig);
  const systemPrompt = [a.systemPrompt, mcpInstructions].filter(Boolean).join("\n\n");
  a.onSetup?.({
    model: route.model, api: route.api, baseUrl: route.baseUrl, contextWindow: route.contextWindow, maxTokens: route.maxTokens,
    reasoningEffort: a.llmConfig.reasoningEffort, systemPrompt, tools: tools.map((t) => t.name),
    toolDefs: tools.map((t) => ({ name: t.name, description: t.description, parameters: JSON.parse(JSON.stringify(t.parameters ?? {})) as unknown })),
  });
  // Mode changes travel with the prompt. In the system prompt they would re-write the provider's
  // cache for the whole conversation on every switch.
  const modeNote = planning ? PLAN_MODE_PROMPT : st.planning ? PLAN_MODE_ENDED : "";
  st.planning = planning;
  const context = [modeNote, a.context].filter(Boolean).map((text) => `<session_context>\n${text}\n</session_context>`).join("\n\n") || undefined;
  // The skill list is context, not part of the tool definition: there it would re-write the cache
  // whenever a skill file changed.
  const skills = tools.some((t) => t.name === "skill") ? skillCatalog({ cwd: a.cwd, contextWindow: a.llmConfig.contextWindow }) : undefined;
  const standingContext = [...(a.standingContext ?? []), skills].filter((text): text is string => !!text).map((text) => `<session_context>\n${text}\n</session_context>`);
  // Children run the parent's tool objects, so anything bound to the parent's own state is withheld:
  // delegation (one level deep), the plan hand-over, and the parent's goal and reminders.
  const subagentToolNames = new Set(["subagent", "delegate", "workflow", "ralph", "send_message", "list_agents", "interrupt_agent", "exit_plan_mode",
    "get_goal", "create_goal", "update_goal", "schedule_create", "schedule_list", "schedule_cancel"]);
  st.spawn = {
    cwd: a.cwd, profile, route, systemPrompt, tools: () => tools.filter((t) => !subagentToolNames.has(t.name)),
    reasoningEffort: a.llmConfig.reasoningEffort, temperature: a.llmConfig.temperature, maxSteps: a.llmConfig.maxSteps,
  };
  const onAbort = (): void => h.abort(a.sessionId);
  if (a.signal?.aborted) onAbort(); else a.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    await h.prompt({
      sessionId: a.sessionId,
      prompt: prepared.text,
      context,
      standingContext,
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
