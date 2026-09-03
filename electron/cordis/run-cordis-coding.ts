/**
 * run-cordis-coding — drive the dsh agent loop for Cairn's CODING agent
 * The dsh agent loop handles the model↔tool↔model iteration internally — this
 * wrapper only:
 *
  *   - mounts the shared Cordis tree + pi-ai adapter (protocol PINNED per the
  *     saved provider's apiMode via prepareCordisRuntime — never auto-probed),
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
import { TOOL_SCHEMAS, dlog, startPhaseTimer, createHostStore } from "./host-store";
import { buildCordisUserContent } from "./cairn-attachment-store";
import { runCordisSession } from "./session-runner";
import { runCordisTurn, type CordisTurnAgent } from "./session-turn";
import type { ChatRequest } from "../lib/tools";
import type { LLMConfig } from "../lib/llm";
import { makeSessionProjection } from "../../shared/agent/session-projection";
import { describeTurnEndReason } from "../../shared/agent/turn-end-reason";
import { isMode, modeFromAutoApprove, type Mode } from "../../shared/agent/approval-mode";

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
  /** When false, mutating tools require user confirmation before running. Default true. @deprecated — use `approvalMode`. */
  autoApprove?: boolean;
  /** OpenWorker-style approval Mode. When set it takes precedence over autoApprove. */
  approvalMode?: Mode;
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
    registerPending: (callId: string, resolve: (decision: { approved: boolean; grant?: "session" | "command" | "workspace" }) => void) => () => void;
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
  /**
   * Usage-view attribution. Defaults to "coding-agent"; automation runs use the
   * coding profile but must be booked as "automation".
   */
  usageSource?: import("../db/usage-queries").UsageSource;
}

export interface RunCordisCodingResult {
  /** True if the turn completed cleanly; false on error/abort. */
  ok: boolean;
  error?: string;
}

export async function runCordisCodingLoop(opts: RunCordisCodingOptions): Promise<RunCordisCodingResult> {
  // Always-on phase timing. The coding path previously had no instrumentation
  // at all, so a slow turn was indistinguishable from a hung one and there was
  // no record after the fact. Each mark below names the work that just finished.
  const timer = startPhaseTimer("cordis-coding", { sessionId: opts.sessionId, model: opts.llmConfig.model });
  const ctx = await getContext();
  timer.mark("getContext");
  const { db, req, workspacePath, sessionId, cwd, systemPrompt, mode, send, questions, approvals, getWin, signal } = opts;
  // Sandbox: confine fs/bash mutations to cwd by default (workspace-write).
  const sandboxMode = opts.sandboxMode ?? "workspace-write";
  // Approval mode: prefer explicit `approvalMode`, then map legacy `autoApprove`
  // (true→auto, false→interactive) so stored configs round-trip. Absent → auto
  // (previous default ON when caller omitted the flag).
  let effectiveMode: Mode;
  if (opts.approvalMode && isMode(opts.approvalMode)) effectiveMode = opts.approvalMode;
  else if (typeof opts.autoApprove === "boolean") effectiveMode = modeFromAutoApprove(opts.autoApprove);
  else effectiveMode = "auto";
  // Fail-closed when caller asked for HITL but forgot the adapter — the gate
  // would be absent and tools would run un-gated. Keep effectiveMode as-is
  // for the policy fold so the audit log reflects "ask", but log the wiring.
  if (effectiveMode !== "auto" && !approvals) {
    console.warn(`[cordis-coding] approval mode ${effectiveMode} but no approvals adapter supplied for ${sessionId} — forcing deny (fail-closed)`);
  }
  // Legacy alias kept for the policy fold below (auto ↔ never, else ask).
  const autoApprove = effectiveMode === "auto";
  let resolveTerminal: (r: RunCordisCodingResult) => void = () => {};
  const onSessionEvent = (event: import("@deepseek-ai/dsh-session").SessionEvent) => {
    opts.onSessionEvent?.(event);
    if (event.type !== "turn/end") return;
    // `reason` is dsh's TurnEndReason. For kind:"error" it carries a structured
    // LlmFailure at `reason.error` ({message, code}) — the ONLY description of
    // what actually went wrong. Reporting the bare kind ("error") threw that
    // away and made every failure mode look identical, so surface the message
    // and code, and mirror the whole reason to the debug log for post-hoc
    // diagnosis (a UNKNOWN-coded failure is a thrown JS error inside the loop,
    // typically a misbehaving plugin, not a provider problem).
    const reasonRaw = (event.data as { reason?: { kind?: string; error?: { message?: string; code?: string } } }).reason;
    const reason = reasonRaw?.kind;
    if (reason === "completed") { resolveTerminal({ ok: true }); return; }
    if (!["aborted", "blocked", "error", "max-tokens", "interrupted"].includes(reason ?? "")) return;
    dlog("cordis-coding", "turn ended abnormally", { sessionId, reason: reasonRaw });
    resolveTerminal({ ok: false, error: describeTurnEndReason(reasonRaw) });
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
      usageSource: opts.usageSource ?? "coding-agent",
      // Bridge subagent child sessions onto session:projection. cairnSubagentPlugin
      // was written for both profiles ("the calling chat thread OR coding-agent
      // session") and self-scopes on header.parentSession, but only chat ever
      // passed an adapter — so the coding agent had the `subagent` tool and a UI
      // that renders traces, with nothing connecting them.
      sendSubagent: send,
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
        const host = createHostStore(db);
        const meta = host.getWorkspaceMeta(req.workspaceId, req.projectId);
        updateWorkspaceContext(sessionId, { workspaceName: meta.workspaceName, workspaceId: req.workspaceId, projectName: meta.projectName, projectId: req.projectId, projectDescription: meta.projectDescription, cwd, gitBranch: host.getGitBranch(cwd) });
      } catch (e) { console.warn("[cordis-coding] workspace context update failed:", e instanceof Error ? e.message : e); }
      timer.mark("workspace-context (incl. git branch execSync)");
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
      timer.mark("registerCairnTools");
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
    // HITL tool approval — mounted whenever an approvals adapter is present.
    // Mode decides what asks: "auto" only gates EXTERNAL, "interactive"/"plan"/"discuss" gate all mutating tools.
    if (approvals) {
      await mount(cairnApprovalPlugin, {
        mode: effectiveMode,
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
    timer.mark("mountCodingStack (13 dsh plugins)");
    let externalDisposers: Array<() => void> = [];
    try {
      // MCP parity spike (opt-in via CAIRN_DSH_MCP_SPIKE, default OFF): when it
      // verifies, the named server is served by dsh-mcp-client and excluded
      // from the hand bridge below. Unset → empty mount + empty exclusion.
      const { maybeMountDshMcpSpike } = await import("./mcp-dsh-bridge");
      const spike = await maybeMountDshMcpSpike(ctx, createHostStore(db), req.workspaceId ?? "", req.projectId ?? "");
      spike.disposers.forEach((dispose) => resources.add(dispose));
      externalDisposers = await registerExternalCairnTools(ctx, {
        db,
        workspaceId: req.workspaceId ?? "",
        projectId: req.projectId ?? "",
      }, { excludeServerIds: spike.excludedServerIds });
    } catch (e) {
      console.error(`[cordis-coding] registerExternalCairnTools failed:`, (e as Error)?.message ?? e);
    }
      externalDisposers.forEach((dispose) => resources.add(dispose));
    // MCP servers are queried over the network here (mcp-client uses a 15s
    // connect timeout per server), so an unreachable connector shows up as a
    // large "externalTools" phase rather than as unexplained turn latency.
    timer.mark("registerExternalCairnTools (MCP listTools over network)");
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
    open: async ({ llmConfig }) => {
      const opened = await openCordisAgent(ctx, { sessionId, cwd, llmConfig, signal });
      // inspect() + resume() both read and fold the whole JSONL log, and the
      // coding profile does NOT retain its agent between turns, so this cost is
      // paid on every turn and grows with transcript length.
      timer.mark("open agent (inspect + resume JSONL)");
      return opened;
    },
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
      // Tool schemas dominate the request's static prefix, so the count is the
      // first thing to check when prefill (and therefore cost/latency) is high.
      else dlog("cordis-coding", "tools registered", { sessionId, count: toolNames.length, tools: toolNames });
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
      const session = typedAgent.session as {
        snapshotEvents?: () => Array<{ type?: string }>;
        events?: Array<{ type?: string }>;
      };
      const events = typeof session?.snapshotEvents === "function"
        ? session.snapshotEvents()
        : (session?.events ?? []);
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
    timer.mark("build user content (pre-turn setup total)");
    const turn = await runCordisTurn({ agent: typedAgent, content, signal, completion: terminal });
    timer.mark("model turn (followup → idle)");
    return (turn.completion as RunCordisCodingResult | undefined) ?? { ok: true };
    },
  }).then(
    (result) => {
      timer.end("coding turn finished", { ok: result.ok, ...(result.error ? { error: result.error } : {}) });
      return result;
    },
    // A throw here is a Cairn-side failure (mount/setup), distinct from a
    // turn/end error reported through onSessionEvent — record the stack, which
    // the previous bare `.catch` discarded along with any timing context.
    (e: unknown) => {
      const error = e instanceof Error ? e : new Error(String(e));
      timer.end("coding turn threw", { error: error.message, stack: error.stack });
      return { ok: false, error: error.message };
    },
  );
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
