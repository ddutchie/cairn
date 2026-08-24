/**
 * run-cordis-coding — drive the dsh agent loop for Cairn's CODING agent
 * The dsh agent loop handles the model↔tool↔model iteration internally — this
 * wrapper only:
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
// See ctx-augment.ts for the rationale — same augmentation load.
import "./ctx-augment";
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
  CAIRN_DB,
} from "./cairn-plugins";
import { cairnDoomLoopPlugin } from "./plugins/doom-loop";
import { registerCairnTools, registerExternalCairnTools } from "./cairn-tools";
import { TOOL_SCHEMAS } from "../lib/tool-schemas";
import { buildCordisUserContent } from "./cairn-attachment-store";
import { resolveTransport, type ApiMode } from "../lib/llm-transport";
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
  /**
   * Session persona. "default" is the coding agent (full toolset).
   * "automation-dev" is the Develop session for authoring an automation's
   * scripts: the pre-Cordis loop restricted this persona to file tools only
   * (read/write/edit/grep/find/ls) via AUTOMATION_DEV_TOOLS. The Cordis
   * equivalent excludes ALL Cairn data tools + bash so the persona cannot
   * write notes/tasks or run shell commands — it can only author the
   * automation's script files (which are executed at run time by a separate,
   * user-consented path).
   */
  role?: "default" | "automation-dev";
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
  const { db, req, workspacePath, sessionId, cwd, systemPrompt, mode, send, questions, approvals, getWin, signal } = opts;
  // llmConfig is mutated below (local-model rewrite); every other opts field
  // is read-only.
  let { llmConfig } = opts;
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
  // automation-dev persona: exclude every Cairn data tool. The pre-Cordis
  // AUTOMATION_DEV_TOOLS whitelist was {read, write, edit, grep, find, ls} —
  // all dsh tools from mountCodingStack, no Cairn data tools. Restoring the
  // exclusion at the Cairn-tools registration is the direct equivalent; the
  // bash exclusion happens below (opts.role check on the mountCodingStack
  // side). This prevents an automation-dev session from touching notes,
  // tasks, or the board via any Cairn tool.
  const cairnToolsExclude = opts.role === "automation-dev"
    ? new Set(Object.keys(TOOL_SCHEMAS))
    : undefined;
  const toolDisposers = registerCairnTools(ctx, {
    getDb: () => (ctx.get(CAIRN_DB) as Database) ?? db,
    req,
    workspacePath,
    llmConfig,
    getWin,
    emit: undefined,
    emitDone: undefined,
  }, cairnToolsExclude ? { exclude: cairnToolsExclude } : undefined);

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
    // Doom-loop guard (bundled plugin, ctx.cairn.confirm pilot): pause on
    // repeated identical tool calls. Mounted BEFORE the approval plugin on
    // purpose: waterfall listeners fire in registration order, and once the
    // approval classifier claims a call with {kind:"ask"} (without calling
    // next()) downstream guards never see it. Mounting doom first means every
    // call — including ones about to be asked — counts toward loop detection;
    // its next() chains into the approval classifier below. Mounted
    // unconditionally: sessions without a confirm transport (headless) fail
    // closed to "cancelled" → deterministic loop-halt.
    await mount(cairnDoomLoopPlugin, {
      sessionId,
      signal,
    });
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
      codingDisposers.push(await mountCodingStack(ctx, { cwd, sandboxMode, role: opts.role }));
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
        // Callers may hand us either dsh's property-map shape ({field: schema})
        // or an OpenAI-style wrapped JSON Schema ({type:"object", properties}).
        // defineTool compiles the OUTER object itself — passing the wrapped
        // form makes every key (including `type`) validate as a property
        // schema and the registration die with JsonSchemaError.
        const raw = def.parameters as { type?: unknown; properties?: Record<string, unknown> } | undefined;
        const parameters = (raw && raw.type === "object" && raw.properties && typeof raw.properties === "object")
          ? raw.properties
          : ((def.parameters ?? {}) as Record<string, unknown>);
        const tool = defineTool({
          name: def.name,
          description: def.description,
          parameters: parameters as never,
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
      // ctx.tools is dsh-tools; `schemas` returns the registered set. The
      // `list?.()` fallback covered a pre-dsh alternative surface — kept as
      // defence, but the primary path is `schemas`.
      const tools = ctx.tools as unknown as { schemas?: (scope?: unknown) => Array<{ function?: { name: string }; name?: string }>; list?: () => Array<{ name: string }> };
      const raw = tools?.schemas?.() ?? tools?.list?.() ?? [];
      const toolNames = (raw as Array<{ function?: { name: string }; name?: string }>)
        .map((s) => (s as { function?: { name: string } })?.function?.name ?? (s as { name?: string })?.name ?? "")
        .filter(Boolean)
        .sort();
      if (toolNames.length === 0) console.error(`[cordis-coding] NO TOOLS REGISTERED — mountCodingStack + registerCairnTools produced 0 tools`);
    } catch (e) {
      console.error(`[cordis-coding] tools diagnostic failed:`, e);
    }

    const _selection = { provider: "cairn", model: llmConfig.model };
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

    // Seed plan state only for a new/legacy session. Once dsh has a plan/mode
    // event, its session log is authoritative and must not be overwritten by
    // Cairn's legacy SQLite mode index on every resumed turn.
    try {
      const events = (agent.session.events ?? []) as Array<{ type?: string }>;
      const hasLoggedMode = events.some((event) => event.type === "plan/mode");
      if (!hasLoggedMode && mode === "plan") ctx.planMode?.set(agent as never, true);
    } catch { /* non-fatal: plan mode falls back to prompt-only guidance */ }

    // Native approval-policy fold (audit §5 Phase C2): record autoApprove as
    // dsh's durable per-session approval/policy instead of silently keeping
    // the pinned "ask" service default — the jsonl audit trail AND the
    // model-visible approval section then reflect reality (auto-approve ⇒
    // "never"; HITL ⇒ "ask"). No-op when unchanged across turns; a resumed
    // session folds its own logged history.
    try {
      ctx.approval?.setPolicy?.(agent as never, autoApprove ? "never" : "ask");
    } catch { /* non-fatal: the per-turn classifier bridge still gates asks */ }

    // Mount the bridge AFTER the agent exists so it knows the dsh session id to
    // match events against (= the caller's sessionId, which is also how events
    // are tagged).
    await mount(cairnCodingPlugin, { sessionId, matchSessionId: String(attemptSessionId), mode, send: combinedSend, signal });

    // Build the user message content: text + any image/PDF attachments. Images
    // are admitted through the mounted attachment store and become ImageBlocks
    // (step 2l); without this, req.images would be silently dropped.
    const content = await buildCordisUserContent(ctx, req.message, req.images);
    // The caller's AbortSignal is not retained by dsh after agent creation.
    // Bridge it to the live agent so the renderer's stop action cancels the
    // actual model/tool loop, including a blocked question or tool call.
    const cancellableAgent = agent as typeof agent & { cancel?: (cause: { kind: "user" }) => void };
    const cancelAgent = () => cancellableAgent.cancel?.({ kind: "user" });
    if (signal?.aborted) cancelAgent();
    else signal?.addEventListener("abort", cancelAgent, { once: true });
    try {
      agent.followup(
        createUserMessage({ content: content as never, source: { kind: "user" } }),
      );

      // Wait for the turn to fully settle (the dsh loop runs all tool steps).
      const doneP = Promise.race([
        terminal,
        agent.whenIdle().then(() => ({ ok: true }) as RunCordisCodingResult),
      ]);
      return await doneP;
    } finally {
      signal?.removeEventListener("abort", cancelAgent);
    }
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

  const pers = ctx.sessionPersistence;
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
    return (await ctx.agents.resume({
      ...base,
      resumeSessionId: attemptSessionId,
      signal,
    })) as H;
  }
  return (await ctx.agentLoop.createAgent(ctx, {
    ...base,
    sessionId: attemptSessionId,
    signal,
  } as never)) as H;
}
