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
  cairnApprovalPlugin,
  cairnDoomLoopPlugin,
  CAIRN_DB,
} from "./cairn-plugins";
import { registerCairnTools, registerExternalCairnTools } from "./cairn-tools";
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
  /**
   * Additional tool definitions to register on ctx.tools for this turn (e.g.
   * automation's run_script / write_run_file / deliver_file). Each is
   * `{ name, description, parameters, execute }` in the dsh ToolDefinition
   * shape. Registered alongside the coding stack + Cairn data tools.
   */
  extraTools?: Array<{ name: string; description: string; parameters: unknown; execute: (args: Record<string, unknown>) => unknown | Promise<unknown> }>;
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
  let { db, req, workspacePath, sessionId, cwd, systemPrompt, llmConfig, mode, send, questions, approvals, doomLoop, getWin, signal } = opts;
  // Local on-device model — ensure the app-spawned llama-server is running and
  // use its OpenAI-compatible endpoint (also via the pi-ai route, no separate plugin).
  if ((llmConfig as { provider?: string }).provider === "localllm") {
    const { ensureLlamaServerRunning } = await import("../lib/llama-server");
    const port = await ensureLlamaServerRunning();
    llmConfig = { ...llmConfig, baseUrl: `http://127.0.0.1:${port}/v1`, provider: "openai" as const };
  }
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
    // Skills (Phase 1.5 step 2i): read the merged skill catalog through the dsh
    // Skills are owned by dsh (`dsh-tool-skill`, mounted globally): it registers
    // the `skill` tool and injects <available_skills> as a per-step
    // user/form:catalog message from the shared SkillRegistry (which holds our
    // SKILL.md provider). So the system prompt here needs no skills XML and we
    // register no skill tool — the section is just the caller's systemPrompt.
    const systemText = systemPrompt;
    await mount(cairnSystemPromptPlugin, { systemText });
    // Plan mode is owned by dsh (`dsh-plan-mode`, mounted in the coding stack):
    // it drives the plan:policy section + exit_plan_mode via planMode.set(agent).
    // No custom read-only tool guard — dsh's plan mode is advisory state.
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
        // Coding renderer listens on pi-agent:ask-questions {sessionId,callId,questions}.
        emitQuestions: (requestId: string, qs: unknown[]) => questions.send("pi-agent:ask-questions", { sessionId, callId: requestId, questions: qs }),
        signal,
      });
    }
    // The dsh coding capability stack (bash/fs/search/editor/todo/plan-mode),
    // cwd-scoped. Order per dsh-base. Mounted before the agent so the tools are
    // registered when the model first requests them.
    try {
      codingDisposers.push(await mountCodingStack(ctx, { cwd, sandboxMode }));
    } catch (e) {
      console.error(`[cordis-coding] mountCodingStack failed:`, (e as Error)?.message ?? e, (e as Error)?.stack ?? "");
      throw e;
    }
    let externalDisposers: Array<() => void> = [];
    try {
      externalDisposers = await registerExternalCairnTools(ctx, {
        db,
        workspaceId: req.workspaceId ?? "",
        projectId: req.projectId ?? "",
      });
    } catch (e) {
      console.error(`[cordis-coding] registerExternalCairnTools failed:`, (e as Error)?.message ?? e);
    }
    toolDisposers.push(...externalDisposers);
    // Automation-specific tools (run_script / write_run_file / deliver_file) —
    // registered from the heartbeat caller via extraTools.
    for (const def of opts.extraTools ?? []) {
      try {
        const { defineTool } = await import("@deepseek-ai/dsh-tools");
        const tool = defineTool({
          name: def.name,
          description: def.description,
          parameters: def.parameters as never,
          output: {
            schema: { type: "json" },
            render: (_args: unknown, value: unknown) => [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }],
          },
          async execute(args) {
            return def.execute(args as Record<string, unknown>) as never;
          },
        });
        toolDisposers.push(ctx.tools.register(tool));
      } catch (e) {
        console.error(`[cordis-coding] register extraTool ${def.name} failed:`, e);
      }
    }

    try {
      const toolsAny = (ctx as unknown as { tools: { schemas?: (scope?: unknown) => Array<{ function?: { name: string }; name?: string }>; list?: () => Array<{ name: string }> } }).tools;
      const raw = toolsAny?.schemas?.() ?? toolsAny?.list?.() ?? [];
      const toolNames = (raw as Array<{ function?: { name: string }; name?: string }>)
        .map((s) => (s as { function?: { name: string } })?.function?.name ?? (s as { name?: string })?.name ?? "")
        .filter(Boolean)
        .sort();
      if (toolNames.length === 0) console.error(`[cordis-coding] NO TOOLS REGISTERED — mountCodingStack + registerCairnTools produced 0 tools`);
    } catch (e) {
      console.error(`[cordis-coding] tools diagnostic failed:`, e);
    }

    const selection = { provider: "cairn", model: llmConfig.model };
    // Stable dsh session id = the caller's pi sessionId. With dsh jsonl
    // persistence mounted, createAgent with a stable id auto-RESUMES the
    // session's materialized history on a remount (first use creates it). This
    // gives the coding agent stateful, resumable multi-turn sessions WITHOUT
    // storing transcripts in Cairn's SQLite (the DB is for MCP/tool access).
    const attemptSessionId = SessionId(sessionId);
    const handle = await openCordisAgent(ctx, { sessionId, cwd, llmConfig, signal });
    const agent = handle.agent as {
      whenIdle: () => Promise<unknown>;
      followup: (m: unknown) => unknown;
      session: { events: unknown[] };
    };
    handleDisposers.push(() => handle.dispose?.() ?? Promise.resolve());
    await agent.whenIdle();

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

/**
 * Create (or resume) a dsh agent for a coding session WITHOUT running a turn.
 * Shared by runCordisCodingLoop and pi-agent:compact-now so manual compaction
 * can act on an idle session. Resumes the persisted jsonl if it exists.
 * The returned handle is idle until followup(); caller disposes it.
 */
export async function openCordisAgent(
  ctx: Context,
  opts: { sessionId: string; cwd: string; llmConfig: LLMConfig; signal?: AbortSignal },
): Promise<{ agent: unknown; dispose?: () => Promise<void> }> {
  const { sessionId, cwd, llmConfig, signal } = opts;
  const selection = { provider: "cairn", model: llmConfig.model };
  const attemptSessionId = SessionId(sessionId);

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

  type H = { agent: unknown; dispose?: () => Promise<void> };
  if (exists) {
    return await (ctx as unknown as { agents: { resume: (o: unknown) => Promise<H> } }).agents.resume({
      ...base,
      resumeSessionId: attemptSessionId,
      signal,
    });
  }
  return await (ctx as unknown as { agentLoop: { createAgent: (c: unknown, o: unknown) => Promise<H> } }).agentLoop.createAgent(ctx, {
    ...base,
    sessionId: attemptSessionId,
    signal,
  } as never);
}
