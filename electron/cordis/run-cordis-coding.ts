/**
 * run-cordis-coding — drive the dsh agent loop for Cairn's CODING agent
 * (Phase 1.5). This is the Cordis equivalent of electron/lib/pi-agent-loop.ts's
 * runAgentLoop, but the dsh agent loop handles the model↔tool↔model iteration
 * internally — this wrapper only:
 *
 *   - mounts the shared Cordis tree + pi-ai adapter (protocol auto-selected),
 *   - mounts the coding capability stack (mountCodingStack) + Cairn data tools,
 *   - mounts cairnCodingPlugin (bridges dsh session/event → pi-agent:* IPC),
 *   - creates a dsh agent for one turn, follows up with the user message,
 *     and awaits idle (the dsh loop runs all tool steps to completion).
 *
 * Every `pi-agent:*` event (token/thought/tool/usage/step/done/error/
 * note-updated/todos/plan-note) is emitted by cairnCodingPlugin via `send`.
 * The terminal promise resolves on `pi-agent:done`/`pi-agent:error` from the
 * plugin's turn/end mapping, or rejects on an unhandled throw.
 */
import { Context } from "@deepseek-ai/cordis";
import { SessionId } from "@deepseek-ai/dsh-session";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { installModelSelection } from "@deepseek-ai/dsh-agent";
import type { Database } from "better-sqlite3";

import { getContext, ensurePiAiAdapter } from "./run-cordis-loop";
import { mountCodingStack } from "./cordis-coding-tools";
import {
  cairnDbPlugin,
  cairnUsagePlugin,
  cairnCodingPlugin,
  cairnQuestionsPlugin,
  cairnSystemPromptPlugin,
  cairnPlanModePlugin,
  cairnApprovalPlugin,
  cairnDoomLoopPlugin,
  CAIRN_DB,
} from "./cairn-plugins";
import { registerCairnTools, registerExternalCairnTools, registerSkillTool, discoverCodingSkills } from "./cairn-tools";
import { renderSkillsXml } from "../lib/skills";
import { buildCordisUserContent } from "./cairn-attachment-store";
import { resolveTransport, markCompletionsOnly, readCachedMode, type ApiMode } from "../lib/llm-transport";
import type { ChatRequest } from "../lib/tools";
import type { LLMConfig } from "../lib/llm";

export interface RunCordisCodingOptions {
  db: Database;
  req: ChatRequest;
  workspacePath: string;
  /** The coding session id — scopes every pi-agent:* event + DB todos. */
  sessionId: string;
  cwd: string;
  systemPrompt: string;
  llmConfig: LLMConfig;
  mode: "plan" | "execute";
  /** When false, mutating tools require user confirmation before running. Default true. */
  autoApprove?: boolean;
  /**
   * Filesystem/bash sandbox mode. "workspace-write" (default) confines all
   * mutations to `cwd`; "read-only" forbids all mutation; "danger-full-access"
   * is unrestricted (legacy behaviour). Automation callers should use
   * "workspace-write" so an agent cannot escape the project root.
   */
  sandboxMode?: "read-only" | "workspace-write" | "danger-full-access";
  /** Emit a pi-agent:* IPC event (sessionId NOT yet tagged by the caller). */
  send: (channel: string, payload: Record<string, unknown>) => void;
  /** Interactive questions (ask_questions) adapter for the coding session. */
  questions?: {
    send: (channel: string, payload: Record<string, unknown>) => void;
    registerPending: (requestId: string, resolve: (answersText: string) => void) => () => void;
  };
  /**
   * Tool-approval adapter (HITL). registerPending stores a resolver keyed by
   * callId that the pi-agent:respond-tool IPC handler invokes with the decision.
   * Required for autoApprove:false; omitted → autoApprove is forced on.
   */
  approvals?: {
    registerPending: (callId: string, resolve: (decision: { approved: boolean; grant?: "session" | "command" }) => void) => () => void;
  };
  /**
   * Doom-loop adapter. registerPending stores a resolver keyed by callId
   * (`${sessionId}:${signature}`) that pi-agent:respond-doom-loop invokes with
   * the user's allow/deny. Omitted → no doom-loop pausing.
   */
  doomLoop?: {
    registerPending: (callId: string, resolve: (allow: boolean) => void) => () => void;
  };
  getWin?: () => Electron.BrowserWindow | null;
  signal?: AbortSignal;
}

export interface RunCordisCodingResult {
  /** True if the turn completed cleanly; false on error/abort. */
  ok: boolean;
  error?: string;
}

export async function runCordisCodingLoop(opts: RunCordisCodingOptions): Promise<RunCordisCodingResult> {
  const ctx = await getContext();
  const { db, req, workspacePath, sessionId, cwd, systemPrompt, llmConfig, mode, send, questions, approvals, doomLoop, getWin, signal } = opts;
  // Sandbox: confine fs/bash mutations to cwd by default (workspace-write).
  const sandboxMode = opts.sandboxMode ?? "workspace-write";  // autoApprove defaults ON; forced ON if no approvals adapter was supplied
  // (no way to prompt → don't block on an approval that can never resolve).
  const autoApprove = opts.autoApprove !== false ? true : (approvals ? false : true);

  // Pick the wire protocol the same way chat + the built-in loop do.
  const transport = await resolveTransport(llmConfig.baseUrl, llmConfig.apiKey);
  const apiFor = (m: ApiMode): "openai-responses" | "openai-completions" =>
    m === "responses" ? "openai-responses" : "openai-completions";
  await ensurePiAiAdapter(ctx, {
    baseUrl: llmConfig.baseUrl,
    model: llmConfig.model,
    apiKey: llmConfig.apiKey,
    api: apiFor(transport.mode),
  });

  const pluginDisposers: Array<() => void> = [];
  const mount = async (plugin: unknown, config: unknown): Promise<void> => {
    const fiber = ctx.plugin(plugin as never, config as never);
    pluginDisposers.push(() => { fiber.then((f) => { try { f.dispose(); } catch { /* noop */ } }, () => {}); });
    await fiber;
  };
  const codingDisposers: Array<() => void> = [];
  // Disposes the active dsh agent handle at turn end so its session is detached
  // from the live registry (persisted jsonl remains, enabling resume).
  const handleDisposers: Array<() => Promise<void> | void> = [];
  const toolDisposers = registerCairnTools(ctx, {
    getDb: () => (ctx.get(CAIRN_DB) as Database) ?? db,
    req,
    workspacePath,
    llmConfig,
    getWin,
    emit: undefined,
    emitDone: undefined,
  });

  const run = async (): Promise<RunCordisCodingResult> => {
    await mount(cairnDbPlugin, { db });
    await mount(cairnUsagePlugin, {
      threadId: sessionId,
      workspaceId: req.workspaceId ?? "",
      projectId: req.projectId,
      provider: llmConfig.provider,
      model: llmConfig.model,
      baseUrl: llmConfig.baseUrl,
    });
    // Skills (Phase 1.5 step 2i): discover SKILL.md metadata under cwd once per
    // turn, inject <available_skills> into the system prompt (name+description
    // only — cheap), and register the `skill` tool that loads a body on demand.
    const skills = discoverCodingSkills(cwd);
    const skillsXml = renderSkillsXml(skills);
    const systemText = skillsXml ? `${systemPrompt}\n\n${skillsXml}` : systemPrompt;
    await mount(cairnSystemPromptPlugin, { systemText });
    // Plan-mode read-only gate (denies mutating tools while plan mode is active).
    await mount(cairnPlanModePlugin, { active: mode === "plan" });
    // HITL tool approval (no-op when autoApprove is on).
    if (!autoApprove && approvals) {
      await mount(cairnApprovalPlugin, {
        autoApprove,
        sessionId,
        send,
        registerPending: approvals.registerPending,
        signal,
      });
    }
    // Doom-loop guard: pause on repeated identical tool calls.
    if (doomLoop) {
      await mount(cairnDoomLoopPlugin, {
        sessionId,
        send,
        registerPending: doomLoop.registerPending,
        signal,
      });
    }
    if (questions) {
      await mount(cairnQuestionsPlugin, {
        send: questions.send,
        registerPending: questions.registerPending,
        signal,
      });
    }
    // The dsh coding capability stack (bash/fs/search/editor/todo/plan-mode),
    // cwd-scoped. Order per dsh-base. Mounted before the agent so the tools are
    // registered when the model first requests them.
    codingDisposers.push(await mountCodingStack(ctx, { cwd, sandboxMode }));
    const externalDisposers = await registerExternalCairnTools(ctx, {
      db,
      workspaceId: req.workspaceId ?? "",
      projectId: req.projectId ?? "",
    });
    toolDisposers.push(...externalDisposers);
    // The `skill` tool (loads a SKILL.md body on demand). No-op when no skills.
    toolDisposers.push(...registerSkillTool(ctx, skills));

    const selection = { provider: "cairn", model: llmConfig.model };
    // Stable dsh session id = the caller's pi sessionId. With dsh jsonl
    // persistence mounted, createAgent with a stable id auto-RESUMES the
    // session's materialized history on a remount (first use creates it). This
    // gives the coding agent stateful, resumable multi-turn sessions WITHOUT
    // storing transcripts in Cairn's SQLite (the DB is for MCP/tool access).
    const attemptSessionId = SessionId(sessionId);

    // Route every pi-agent:* event to BOTH the renderer (frontend `send`) and a
    // terminal resolver so the turn promise settles on done/error. cairnCodingPlugin
    // is mounted with `send` = this combined function.
    let resolveTerminal: (r: RunCordisCodingResult) => void = () => {};
    const terminal = new Promise<RunCordisCodingResult>((resolve) => { resolveTerminal = resolve; });
    const combinedSend = (channel: string, payload: Record<string, unknown>) => {
      if (channel === "pi-agent:done") { resolveTerminal({ ok: true }); }
      else if (channel === "pi-agent:error") { resolveTerminal({ ok: false, error: (payload.error as string) ?? "Agent error" }); }
      send(channel, payload);
    };

    // A minimal view of the dsh agent handle we drive (whenIdle/followup/session).
    type DriveAgent = {
      whenIdle: () => Promise<unknown>;
      followup: (m: unknown) => unknown;
      session: { events: unknown[] };
    };
    type DriveHandle = { agent: DriveAgent; dispose?: () => Promise<void> };
    const handle = await (async (): Promise<DriveHandle> => {
      // If the session already has a persisted log, RESUME it so the model sees
      // prior turns (stateful multi-turn). Otherwise create fresh. dsh owns the
      // session transcript (jsonl) — nothing is written to Cairn's SQLite.
      const pers = (ctx as unknown as { sessionPersistence?: { inspect: (id: unknown, signal?: AbortSignal) => Promise<{ events: readonly unknown[] }> } }).sessionPersistence;
      let exists = false;
      try {
        if (pers) {
          const insp = await pers.inspect(attemptSessionId, signal);
          exists = insp.events.length > 0;
        }
      } catch { /* treat as fresh on any inspection error */ }
      const base = {
        meta: { cwd },
        agentOptions: { provider: selection.provider, model: selection.model },
        setup: (agentCtx: unknown) => {
          installModelSelection(agentCtx as never, { current: selection, assembled: undefined });
        },
      };
      if (exists) {
        return await (ctx as unknown as { agents: { resume: (o: unknown) => Promise<DriveHandle> } }).agents.resume({
          ...base,
          resumeSessionId: attemptSessionId,
          signal,
        });
      }
      return await (ctx as unknown as { agentLoop: { createAgent: (c: unknown, o: unknown) => Promise<DriveHandle> } }).agentLoop.createAgent(ctx, {
        ...base,
        sessionId: attemptSessionId,
        signal,
      } as never);
    })();
    const agent = handle.agent;
    handleDisposers.push(() => handle.dispose?.() ?? Promise.resolve());
    await agent.whenIdle();

    // Set the dsh plan state so the plan-mode policy section renders and the
    // exit_plan_mode tool works (state is logged + persisted across resume).
    try {
      (ctx as unknown as { planMode?: { set: (a: unknown, active: boolean) => unknown } }).planMode?.set(agent, mode === "plan");
    } catch { /* non-fatal: plan mode falls back to prompt-only guidance */ }

    // Mount the bridge AFTER the agent exists so it knows the dsh session id to
    // match events against (= the caller's sessionId, which is also how events
    // are tagged).
    await mount(cairnCodingPlugin, { sessionId, matchSessionId: String(attemptSessionId), mode, send: combinedSend, signal });

    // Build the user message content: text + any image/PDF attachments. Images
    // are admitted through the mounted attachment store and become ImageBlocks
    // (step 2l); without this, req.images would be silently dropped.
    const content = await buildCordisUserContent(ctx, req.message, req.images);
    agent.followup(
      createUserMessage({ content: content as never, source: { kind: "user" } }),
    );

    // Wait for the turn to fully settle (the dsh loop runs all tool steps).
    const doneP = Promise.race([
      terminal,
      agent.whenIdle().then(() => ({ ok: true }) as RunCordisCodingResult),
    ]);
    return await doneP;
  };

  let result: RunCordisCodingResult;
  try {
    result = await run();
  } catch (e) {
    result = { ok: false, error: (e as Error)?.message ?? String(e) };
  } finally {
    for (const d of handleDisposers) { try { await d(); } catch { /* noop */ } }
    codingDisposers.forEach((d) => { try { d(); } catch { /* noop */ } });
    toolDisposers.forEach((d) => { try { d(); } catch { /* noop */ } });
    pluginDisposers.forEach((d) => { try { d(); } catch { /* noop */ } });
  }
  return result;
}
