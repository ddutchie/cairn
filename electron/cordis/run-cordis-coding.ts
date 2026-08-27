/**
 * run-cordis-coding — drive the dsh agent loop for Cairn's CODING agent
 * The dsh agent loop handles the model↔tool↔model iteration internally — this
 * wrapper only:
 *
 *   - mounts the shared Cordis tree + pi-ai adapter (protocol auto-selected),
 *   - mounts the coding capability stack (mountCodingStack) + Cairn data tools,
 *   - mounts cairnCodingPlugin (bridges dsh session/event → Cairn projections),
 *   - creates a dsh agent for one turn, follows up with the user message,
 *     and awaits idle (the dsh loop runs all tool steps to completion).
 *
 * Presentation updates are emitted as typed session projections. The terminal
 * promise resolves from the raw DSH `turn/end` event, or rejects on an
 * unhandled throw.
 */
import { Context } from "@deepseek-ai/cordis";
// See ctx-augment.ts for the rationale — same augmentation load.
import "./ctx-augment";
import { SessionId } from "@deepseek-ai/dsh-session";
import type { Database } from "better-sqlite3";

import { getContext } from "./run-cordis-loop";
import { openCordisSessionAgent } from "./session-agent";
import { mountCodingStack } from "./cordis-coding-tools";
import {
  cairnCodingPlugin,
  cairnSystemPromptPlugin,
  cairnApprovalPlugin,
  CAIRN_DB,
} from "./cairn-plugins";
import { cairnDoomLoopPlugin } from "./plugins/doom-loop";
import { registerCairnTools, registerExternalCairnTools } from "./cairn-tools";
import { TOOL_SCHEMAS } from "../lib/tool-schemas";
import { buildCordisUserContent } from "./cairn-attachment-store";
import { runCordisSession } from "./session-runner";
import { runCordisTurn, type CordisTurnAgent } from "./session-turn";
import type { ChatRequest } from "../lib/tools";
import type { LLMConfig } from "../lib/llm";
import { makeSessionProjection } from "../../shared/agent/session-projection";

export interface RunCordisCodingOptions {
  db: Database;
  req: ChatRequest;
  workspacePath: string;
  /** The coding session id — scopes every session:* event + DB todos. */
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
  /** Emit a session projection (sessionId NOT yet tagged by the caller). */
  send: (channel: string, payload: Record<string, unknown>) => void;
  /** Interactive questions (ask_questions) adapter for the coding session. */
  questions?: {
    send: (channel: string, payload: Record<string, unknown>) => void;
    registerPending: (requestId: string, resolve: (answersText: string) => void) => () => void;
  };
  /**
   * Tool-approval adapter (HITL). registerPending stores a resolver keyed by
   * callId that the session:respond-tool IPC handler invokes with the decision.
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
  onSessionEvent?: (event: import("@deepseek-ai/dsh-session").SessionEvent) => void;
}

export interface RunCordisCodingResult {
  /** True if the turn completed cleanly; false on error/abort. */
  ok: boolean;
  error?: string;
}

export async function runCordisCodingLoop(opts: RunCordisCodingOptions): Promise<RunCordisCodingResult> {
  const ctx = await getContext();
  const { db, req, workspacePath, sessionId, cwd, systemPrompt, mode, send, questions, approvals, getWin, signal } = opts;
  // Sandbox: confine fs/bash mutations to cwd by default (workspace-write).
  const sandboxMode = opts.sandboxMode ?? "workspace-write";
  // autoApprove defaults ON, but when caller explicitly asks for HITL (false) and
  // forgets to pass an approvals adapter, fail CLOSED with a warning instead of
  // silently forcing allow-all (P0-4).
  let autoApprove: boolean;
  if (opts.autoApprove !== false) autoApprove = true;
  else if (approvals) autoApprove = false;
  else {
    console.warn(`[cordis-coding] autoApprove:false but no approvals adapter supplied for ${sessionId} — forcing deny (fail-closed)`);
    autoApprove = false;
    // approvals stays undefined → cairnApprovalPlugin not mounted, so tools/pre-execute
    // would run un-gated; instead we rely on dsh ApprovalService going unavailable → deny.
    // Log the mis-wiring so the caller is visible.
  }
  let resolveTerminal: (r: RunCordisCodingResult) => void = () => {};
  const onSessionEvent = (event: import("@deepseek-ai/dsh-session").SessionEvent) => {
    opts.onSessionEvent?.(event);
    if (event.type !== "turn/end") return;
    const reason = (event.data as { reason?: { kind?: string } }).reason?.kind;
    if (reason === "completed") resolveTerminal({ ok: true });
    else if (["aborted", "blocked", "error", "max-tokens"].includes(reason ?? "")) {
      resolveTerminal({ ok: false, error: reason ? `Agent turn ended abnormally (${reason})` : "Agent turn ended abnormally" });
    }
  };

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
  return runCordisSession<RunCordisCodingResult>({
    ctx, db, req, sessionId, llmConfig: opts.llmConfig, signal,
      profileId: opts.role === "automation-dev" ? "automation-dev" : "coding",
      cwd,
      workspaceId: req.workspaceId,
      projectId: req.projectId,
      questions: questions ? {
      ...questions,
       emitQuestions: (requestId, qs) => questions.send("session:projection", makeSessionProjection(sessionId, "question", { callId: requestId, questions: qs }) as never),
      } : undefined,
     onSessionEvent,
    setup: async ({ llmConfig, resources, mount }) => {
      try {
        const { updateWorkspaceContext } = await import("./plugins/workspace-context");
        const wsRow = req.workspaceId ? db.prepare("SELECT name FROM workspaces WHERE id = ?").get(req.workspaceId) as { name?: string } | undefined : undefined;
        const projRow = req.projectId ? db.prepare("SELECT name, description FROM projects WHERE id = ?").get(req.projectId) as { name?: string; description?: string } | undefined : undefined;
        let gitBranch: string | undefined;
        try {
          const { execSync } = await import("node:child_process");
          gitBranch = execSync("git branch --show-current", { cwd, encoding: "utf8", timeout: 800 }).trim() || undefined;
        } catch { /* not a git repo */ }
        updateWorkspaceContext(sessionId, { workspaceName: wsRow?.name, projectName: projRow?.name, projectDescription: projRow?.description, cwd, gitBranch });
      } catch (e) { console.warn("[cordis-coding] workspace context update failed:", e instanceof Error ? e.message : e); }
      const toolDisposers = registerCairnTools(ctx, {
        getDb: () => (ctx.get(CAIRN_DB) as Database) ?? db,
        req,
        workspacePath,
        llmConfig,
        getWin,
        emit: undefined,
        emitDone: undefined,
      }, cairnToolsExclude ? { exclude: cairnToolsExclude } : undefined);
      toolDisposers.forEach((dispose) => resources.add(dispose));
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
      await mount(cairnDoomLoopPlugin, { sessionId, signal });
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
    // The dsh coding capability stack (bash/fs/search/editor/todo/plan-mode),
    // cwd-scoped. Order per dsh-base. Mounted before the agent so the tools are
    // registered when the model first requests them.
    try {
      resources.add(await mountCodingStack(ctx, { cwd, sandboxMode, role: opts.role }));
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
      externalDisposers.forEach((dispose) => resources.add(dispose));
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
        resources.add(ctx.tools.register(tool));
      } catch (e) {
        console.error(`[cordis-coding] register extraTool ${def.name} failed:`, e);
      }
    }
    },
    open: ({ llmConfig }) => openCordisAgent(ctx, { sessionId, cwd, llmConfig, signal }),
    run: async ({ agent, mount }) => {
      const typedAgent = agent as CordisTurnAgent & { session: { events: unknown[] } };
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

    // Stable dsh session id = the caller's pi sessionId. With dsh jsonl
    // persistence mounted, createAgent with a stable id auto-RESUMES the
    // session's materialized history on a remount (first use creates it). This
    // gives the coding agent stateful, resumable multi-turn sessions WITHOUT
    // storing transcripts in Cairn's SQLite (the DB is for MCP/tool access).
    const attemptSessionId = SessionId(sessionId);
    // Route presentation projections to the renderer. Terminal resolution is
    // handled separately from the raw DSH event callback above.
    const terminal = new Promise<RunCordisCodingResult>((resolve) => { resolveTerminal = resolve; });
    const combinedSend = (channel: string, payload: Record<string, unknown>) => send(channel, payload);

    // Seed plan state only for a new/legacy session. Once dsh has a plan/mode
    // event, its session log is authoritative and must not be overwritten by
    // Cairn's legacy SQLite mode index on every resumed turn.
    try {
      const events = (typedAgent.session.events ?? []) as Array<{ type?: string }>;
      const hasLoggedMode = events.some((event) => event.type === "plan/mode");
      if (!hasLoggedMode && mode === "plan") ctx.planMode?.set(typedAgent as never, true);
    } catch { /* non-fatal: plan mode falls back to prompt-only guidance */ }

    // Native approval-policy fold (audit §5 Phase C2): record autoApprove as
    // dsh's durable per-session approval/policy instead of silently keeping
    // the pinned "ask" service default — the jsonl audit trail AND the
    // model-visible approval section then reflect reality (auto-approve ⇒
    // "never"; HITL ⇒ "ask"). No-op when unchanged across turns; a resumed
    // session folds its own logged history.
    try {
      ctx.approval?.setPolicy?.(typedAgent as never, autoApprove ? "never" : "ask");
    } catch { /* non-fatal: the per-turn classifier bridge still gates asks */ }

    // Mount the bridge AFTER the agent exists so it knows the dsh session id to
    // match events against (= the caller's sessionId, which is also how events
    // are tagged).
      await mount(cairnCodingPlugin, { sessionId, matchSessionId: String(attemptSessionId), mode, send: combinedSend, signal });

    // Build the user message content: text + any image/PDF attachments. Images
    // are admitted through the mounted attachment store and become ImageBlocks
    // (step 2l); without this, req.images would be silently dropped.
    const content = await buildCordisUserContent(ctx, req.message, req.images);
    const turn = await runCordisTurn({ agent: typedAgent, content, signal, completion: terminal });
    return (turn.completion as RunCordisCodingResult | undefined) ?? { ok: true };
    },
  }).catch((e) => ({ ok: false, error: (e as Error)?.message ?? String(e) }));
}

/**
 * Create (or resume) a dsh agent for a coding session WITHOUT running a turn.
 * Shared by runCordisCodingLoop and session:compact-now so manual compaction
 * can act on an idle session. Resumes the persisted jsonl if it exists.
 * The returned handle is idle until followup(); caller disposes it.
 */
export async function openCordisAgent(
  ctx: Context,
  opts: { sessionId: string; cwd: string; llmConfig: LLMConfig; signal?: AbortSignal },
): Promise<{ agent: unknown; dispose?: () => Promise<void> }> {
  return openCordisSessionAgent(ctx, opts);
}
