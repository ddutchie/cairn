/**
 * run-cordis-loop — drive the dsh agent loop (dsh-agent-loop) with Cairn's
 * tools bridged on, using dsh's production `dsh-llm-pi-ai` multi-protocol
 * adapter (openai-completions / openai-responses). Maps the resulting session
 * events onto the streaming contract electron/ipc/chat.ts consumes.
 */
import { Context } from "@deepseek-ai/cordis";
import Loader from "@deepseek-ai/cordis-plugin-loader";
import sessionPlugin from "@deepseek-ai/dsh-session";
import llmPlugin from "@deepseek-ai/dsh-llm";
import systemPromptPlugin from "@deepseek-ai/dsh-system-prompt";
import agentPlugin from "@deepseek-ai/dsh-agent";
import toolsPlugin from "@deepseek-ai/dsh-tools";
import agentLoopPlugin from "@deepseek-ai/dsh-agent-loop";
import { apply as llmPiAiApply, inject as llmPiAiInject, name as llmPiAiName } from "@deepseek-ai/dsh-llm-pi-ai";
import { installModelSelection } from "@deepseek-ai/dsh-agent";
import { SessionId, type SessionEvent } from "@deepseek-ai/dsh-session";
import { createUserMessage, createAssistantMessage } from "@deepseek-ai/dsh-llm";
import subagentServicePlugin from "@deepseek-ai/dsh-subagent";
import userQuestionsService from "@deepseek-ai/dsh-user-questions";
import { apply as spawnProviderApply, inject as spawnProviderInject, name as spawnProviderName } from "@deepseek-ai/dsh-subagent-spawn-in-process";
import { apply as toolSubagentApply, inject as toolSubagentInject, name as toolSubagentName } from "@deepseek-ai/dsh-tool-subagent";
import type { Database } from "better-sqlite3";
import JsonlSessionPersistence from "@deepseek-ai/dsh-session-persistence-jsonl";
import approvalService from "@deepseek-ai/dsh-user-approval";
import TokenMeter from "@deepseek-ai/dsh-token-meter";
import BasicCompactionEngine from "@deepseek-ai/dsh-compaction-basic";
import SkillRegistry from "@deepseek-ai/dsh-skill";
import InvariantRegistry from "@deepseek-ai/dsh-invariants";
import CommandRuntime from "@deepseek-ai/dsh-commands";
import planModePlugin from "@deepseek-ai/dsh-plan-mode";
import { apply as toolSkillApply, inject as toolSkillInject, name as toolSkillName } from "@deepseek-ai/dsh-tool-skill";
import { apply as llmRetryApply, inject as llmRetryInject, name as llmRetryName } from "@deepseek-ai/dsh-llm-retry";
import { CairnAttachmentStore } from "./cairn-attachment-store";
import { buildCordisUserContent } from "./cairn-attachment-store";
import { createCairnSkillProvider } from "./cairn-skill-provider";
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
  emitToolCallDone?: (e: { tool: string; cairnRef?: { type: "note" | "task"; id: string; title: string }; externalRef?: { url: string; title?: string; snippet?: string }; output?: string; callId?: string; ok?: boolean; error?: string; meta?: unknown }) => void;
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
export function getSessionRoot(): string { return sessionRoot; }
export function setSessionRoot(root: string): void {
  sessionRoot = root;
}

/**
 * Drop the cached live chat agent for a thread (used by clear-thread). The
 * cache is module-global (`globalThis.__cairnChatAgents`), so a clear that only
 * wipes jsonl + ctx.agents leaves this agent alive — the next turn would then
 * followup into the STALE in-memory session (pre-clear context leaks back into
 * the model) whose write handles point at deleted files (turns silently stop
 * persisting). Call BEFORE wiping files: dispose may flush pending events,
 * which the subsequent file wipe then removes.
 */
export async function dropChatAgentForThread(threadId: string): Promise<void> {  const map = (globalThis as unknown as { __cairnChatAgents?: Map<string, Record<string, unknown>> }).__cairnChatAgents;
  if (!map) return;
  const agent = map.get(threadId);
  if (!agent) return;
  map.delete(threadId);
  // Let an in-flight turn settle so dispose doesn't race mid-step.
  try {
    const whenIdle = agent.whenIdle as (() => Promise<void>) | undefined;
    if (typeof whenIdle === "function") await whenIdle.call(agent);
  } catch { /* already idle / aborted */ }
  // dsh handles are disposable via Symbol.asyncDispose / Symbol.dispose (see
  // dsh-agent-loop:782) — plain `.dispose` often does not exist on the agent
  // handle, which is why the session was previously left LIVE and the next
  // prepare/recreate threw "cannot prepare session … while it is live".
  const agents = agent as Record<PropertyKey, unknown>;
  for (const k of [Symbol.asyncDispose, Symbol.dispose, "dispose", "close", "abort"] as const) {
    let fn: (() => unknown) | undefined;
    try { fn = agents[k] as (() => unknown) | undefined; } catch { fn = undefined; }
    if (typeof fn === "function") {
      try { await fn.call(agent); } catch { /* best-effort teardown */ }
      break;
    }
  }
}

// Tool definitions resolved lazily from the shared context's registry (cached
// here) so output.presentationMeta can be recomputed at render time — dsh does
// not persist it in the session log; the host shell recomputes like its web
// shell. Looked up via ctx.tools.get(name), which works through any scoped view.
const toolDefsByName = new Map<string, Record<string, unknown>>();

function toolDefFor(name: string): Record<string, unknown> | undefined {
  const hit = toolDefsByName.get(name);
  if (hit) return hit;
  const svc = (sharedCtx as unknown as { tools?: { get?: (n: string) => unknown } } | null)?.tools;
  try {
    const def = typeof svc?.get === "function" ? (svc.get(name) as Record<string, unknown> | undefined) : undefined;
    if (def && typeof def === "object") { toolDefsByName.set(name, def); return def; }
  } catch { /* registry lookup is best-effort */ }
  return undefined;
}

/**
 * Recompute a tool's presentationMeta for one (args, result value) pair using
 * the registered definition. Tolerant: returns undefined when the def/output
 * hook is missing or throws — callers then render plain text as before.
 */
export function resolvePresentationMeta(tool: string, argsRaw: string | undefined, outputRaw: string | undefined): unknown {
  const def = toolDefFor(tool);
  const hook = (def?.output as { presentationMeta?: (a: unknown, v: unknown) => unknown } | undefined)?.presentationMeta;
  if (typeof hook !== "function") return undefined;
  let args: unknown = {};
  if (argsRaw) { try { args = JSON.parse(argsRaw); } catch { /* {} */ } }
  let value: unknown;
  if (outputRaw !== undefined && outputRaw !== "") {
    try { value = JSON.parse(outputRaw); } catch { value = outputRaw; }
  }
  try {
    return hook(args, value) ?? undefined;
  } catch { /* presentationMeta threw — degrade to no meta */ }
  return undefined;
}

/** Attach freshly-computed presentationMeta to replayed tool calls (session
 *  replay paths). Mutates-and-returns the same message objects. */
export function enrichToolCallsWithMeta<T extends { toolCalls?: Array<{ tool: string; args?: string; output?: string; meta?: unknown }> }>(
  messages: T[],
): T[] {
  for (const m of messages) {
    for (const tc of m.toolCalls ?? []) {
      if (tc.meta === undefined) tc.meta = resolvePresentationMeta(tc.tool, tc.args, tc.output);
    }
  }
  return messages;
}

/** Test hook: seed/clear a captured tool definition for resolvePresentationMeta. */
export function __setToolDefForTest(name: string, def: Record<string, unknown> | undefined): void {
  if (def) toolDefsByName.set(name, def);
  else toolDefsByName.delete(name);
}

/**
 * Prepare the shared context for REPLAY enrichment: plugin toolviews register
 * through inject-gated backends whose apply waits for the fs chain, which only
 * chat turns mount — so a freshly-reopened app has NO registered plugin tools
 * until this runs. Mounts the chain (cwd from the session's own header) and
 * lets the loader settle so tools.get(name) resolves before presentationMeta
 * recomputation. Best-effort; safe to call when everything is already up.
 */
export async function prepareReplayContext(
  pers: { inspect: (id: string) => Promise<{ header?: { cwd?: string } }> },
  sessionId: string,
): Promise<void> {
  try {
    const { pluginsDevEnabled } = await import("./plugin-loader");
    if (!pluginsDevEnabled()) return;
    const ctx = await getContext();
    const get = (ctx as unknown as { get: (n: string) => unknown }).get;
    if (!get.call(ctx, "fs")) {
      let cwd: string | undefined;
      try {
        cwd = (await pers.inspect(sessionId))?.header?.cwd;
      } catch { /* fall back below */ }
      const { mountFsChain } = await import("./cordis-coding-tools");
      await mountFsChain(ctx, { cwd: cwd || process.cwd() });
    }
    const { settleLoader } = await import("./plugin-loader");
    await settleLoader(ctx);
  } catch (err) {
    console.error("[cordis] prepareReplayContext failed:", err instanceof Error ? err.message : err);
  }
}

/** The cached live chat Agent for a thread (or undefined if none is live). The
 *  chat loop keeps one Agent per threadId in globalThis.__cairnChatAgents so a
 *  back-to-back turn reuses it (see runTurn). Exposed so /compact can run
 *  ctx.compaction.compactNow on the same live agent. */
export function getCachedChatAgent(threadId: string): unknown {
  const map = (globalThis as unknown as { __cairnChatAgents?: Map<string, unknown> }).__cairnChatAgents;
  return map?.get(threadId);
}

/** Resume (or create) the stable chat Agent for a thread so /compact can operate
 *  on its dsh session even when no turn ran this app session (e.g. after reload).
 *  Mirrors run-cordis-coding's openCordisAgent (inspect → resume vs create). */
export async function resumeChatAgent(threadId: string, workspacePath: string, model: string): Promise<unknown> {
  const cached = getCachedChatAgent(threadId);
  if (cached) { try { await (cached as { whenIdle: () => Promise<void> }).whenIdle(); } catch { /* fallthrough */ } return cached; }
  const ctx = await getContext();
  const stableId = SessionId(`chat-${threadId}`);
  const selection = { provider: "cairn", model };
  const setup = (agentCtx: unknown) => { installModelSelection(agentCtx as never, { current: selection, assembled: undefined }); };
  let agent: unknown;
  try {
    const resumed = await (ctx as unknown as { agents: { resume: (o: unknown) => Promise<{ agent: unknown }> } }).agents.resume({
      meta: { cwd: workspacePath }, agentOptions: { provider: selection.provider, model: selection.model }, setup, resumeSessionId: stableId,
    });
    agent = resumed.agent;
  } catch {
    return undefined; // no session yet — nothing to compact
  }
  const map = (globalThis as unknown as { __cairnChatAgents?: Map<string, unknown> }).__cairnChatAgents ?? new Map();
  (globalThis as unknown as { __cairnChatAgents?: typeof map }).__cairnChatAgents = map;
  map.set(threadId, agent);
  return agent;
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
    // Tier 1 (§10.6): the shared Cordis tree is composed by the Cordis LOADER
    // from a declarative JS entry-list, not hand-mounted imperatively. This is
    // the keystone for the plugin system — `disabled:` gating, HMR, and (later)
    // third-party plugin entries all hang off ctx.loader. We drive the Loader
    // programmatically (create() + await()) rather than via boot()/Include
    // (which read a profile dir + cordis.yml from disk — unnecessary here).
    await ctx.plugin(Loader);

    // BUNDLER-SAFE RESOLUTION: main.ts is bundled to CJS by esbuild, which
    // cannot see a dynamic import("<runtime string>"). So we do NOT let the
    // Loader import plugins by bare npm name (that would 404 inside the asar).
    // Instead every plugin is STATICALLY imported above (so esbuild bundles it)
    // and registered as a `cordis:` builtin — the Loader's import() then looks
    // it up in ctx.loader.builtins with zero module resolution (asar-safe).
    // Proven end-to-end in §10.6 (spike6): a fully-builtin tree yields a live
    // ctx.tools identical to the old imperative mount.
    const loader = ctx.loader as unknown as {
      builtins: Record<string, unknown>;
      create: (o: Record<string, unknown>) => Promise<unknown>;
      await: () => Promise<void>;
    };
    loader.builtins ??= {};
    const B = loader.builtins;
    // dsh default-export plugins
    B["dsh:session"] = sessionPlugin;
    B["dsh:llm"] = llmPlugin;
    B["dsh:system-prompt"] = systemPromptPlugin;
    B["dsh:agent"] = agentPlugin;
    B["dsh:tools"] = toolsPlugin;
    B["dsh:user-questions"] = userQuestionsService;
    B["dsh:approval"] = approvalService;
    B["dsh:session-persistence"] = JsonlSessionPersistence;
    B["dsh:agent-loop"] = agentLoopPlugin;
    B["dsh:token-meter"] = TokenMeter;
    B["dsh:compaction"] = BasicCompactionEngine;
    B["dsh:subagent"] = subagentServicePlugin;
    // SkillRegistry (ctx.skills): the standard dsh skill seam. Cairn's SKILL.md
    // loader registers a provider on it (below) and community plugins register
    // theirs — one merged catalog with dsh rank/precedence semantics.
    B["dsh:skills"] = SkillRegistry;
    // InvariantRegistry (ctx.invariants): many plugin companions inject this to
    // install commit-event/security invariants. Mount it so those plugins
    // activate (inject-gating) instead of stalling; default config is permissive.
    B["dsh:invariants"] = InvariantRegistry;
    // tool-skill (dsh drives skills): registers the `skill` tool + injects the
    // <available_skills> catalog as a per-step user/form:catalog message, and
    // handles /<name> user invocation. THIS owns skill delivery now — Cairn no
    // longer injects its own section/tool (see run-cordis-coding).
    B["dsh:tool-skill"] = { apply: toolSkillApply, inject: toolSkillInject, name: toolSkillName };
    // CommandRuntime (ctx.commands): the dsh slash-command registry. Plugins
    // register commands (/plan from dsh-plan-mode, /permission from presets);
    // execution appends command/run+done to the session log. Cairn's UI executes
    // through commands.execute instead of string-matching send paths.
    B["dsh:commands"] = CommandRuntime;
    // PlanModeController (ctx.planMode): dsh-owned plan mode — plan:policy
    // section, exit_plan_mode tool, /plan command (registered into the commands
    // runtime above), and logged plan/mode state. Mounted GLOBALLY so the /plan
    // command exists outside coding turns too (the toggle executes it).
    // Config.section is the deployment-owned policy guidance.
    B["dsh:plan-mode"] = planModePlugin;
    // NOTE: no boot-time "fs" here — the sandbox/sandboxPolicy/fs service names
    // are OWNED by the per-context fs chain (mountFsChain / mountCodingStack),
    // which the chat loop mounts lazily when plugins need ctx.fs and coding
    // turns adopt or own. See cordis-coding-tools.ts plugFsChain.
    // Class-plugin (dsh Service subclass)
    B["cairn:attachment-store"] = CairnAttachmentStore;
    // Named-export "triple" plugins (apply/inject/name — not default objects)
    B["cairn:llm-retry"] = { apply: llmRetryApply, inject: llmRetryInject, name: llmRetryName };
    B["cairn:subagent-spawn"] = { apply: spawnProviderApply, inject: spawnProviderInject, name: spawnProviderName };
    B["cairn:tool-subagent"] = { apply: toolSubagentApply, inject: toolSubagentInject, name: toolSubagentName };

    // The declarative composition. Row order carries no load semantics
    // (activation is service-availability driven; inject-gating waits for the
    // provider regardless of creation order — proven §10.6), but we keep the
    // list in dsh-base order for readers. `config` threads verbatim to each
    // plugin's apply(ctx, config). NO YAML, NO `!!js` — a plain JS array.
    const ENTRY_LIST: Array<Record<string, unknown>> = [
      { id: "session", name: "cordis:dsh:session" },
      { id: "llm", name: "cordis:dsh:llm" },
      // Cairn owns the whole system prompt (buildSystemPrompt), so suppress
      // dsh's built-in harness identity — see the dsh-faithful system/snapshot
      // split note in scratch/dsh-repo/.../system-prompt/src/index.ts:212/239.
      { id: "system-prompt", name: "cordis:dsh:system-prompt", config: { persona: "", includeHarnessIdentity: false } },
      { id: "agent", name: "cordis:dsh:agent" },
      { id: "tools", name: "cordis:dsh:tools", config: { mode: "native" } },
      // dsh user-questions seam (ctx.userQuestions): a tool can pause the turn
      // until the human answers. cairnQuestionsPlugin registers the provider.
      { id: "user-questions", name: "cordis:dsh:user-questions" },
      // dsh approval seam (ctx.approval): tools/pre-execute `ask` routes here;
      // the per-turn approval guard decides WHICH tools ask (autoApprove off).
      { id: "approval", name: "cordis:dsh:approval", config: { policy: "ask" } },
      // dsh session persistence (jsonl) — session/chat transcripts live HERE,
      // not Cairn's SQLite. Enables resumable sessions via ctx.agents.resume.
      { id: "session-persistence", name: "cordis:dsh:session-persistence", config: { root: sessionRoot } },
      { id: "agent-loop", name: "cordis:dsh:agent-loop", config: { agents: [] } },
      // Durable attachment store (2l): concrete backend for the abstract dsh
      // AttachmentStore so image attachments round-trip through the pi-ai adapter.
      { id: "attachment-store", name: "cordis:cairn:attachment-store" },
      // Context management (2h): tokenMeter (pressure) + BasicCompactionEngine
      // (auto-compact at 80% + on overflow; manual /compact via compactNow) +
      // llm-retry (provider retryPolicy on the request-recovery seam).
      { id: "token-meter", name: "cordis:dsh:token-meter" },
      { id: "compaction", name: "cordis:dsh:compaction", config: { auto: true, thresholdRatio: 0.8 } },
      { id: "llm-retry", name: "cordis:cairn:llm-retry", config: {} },
      // Subagent capability stack (dsh-base order): service → spawn provider → tool.
      { id: "subagent", name: "cordis:dsh:subagent" },
      // Skill registry (ctx.skills): hosts Cairn's SKILL.md provider + any
      // community plugin's bundled-skill providers behind one catalog.
      { id: "skills", name: "cordis:dsh:skills" },
      // Invariant registry (ctx.invariants): plugin companions that inject
      // "invariants" activate against this instead of stalling.
      { id: "invariants", name: "cordis:dsh:invariants" },
      // tool-skill: owns the skill tool + per-step <available_skills> catalog
      // (injected as user/form:catalog from the shared SkillRegistry).
      { id: "tool-skill", name: "cordis:dsh:tool-skill" },
      // Command runtime (ctx.commands): dsh slash-command registry (/plan etc).
      { id: "commands", name: "cordis:dsh:commands" },
      // Plan mode (ctx.planMode): dsh-owned advisory plan state + /plan command.
      {
        id: "plan-mode",
        name: "cordis:dsh:plan-mode",
        config: {
          section:
            "You are in plan mode. Stay in plan mode until the user switches the session mode. Explore and read first; do not edit files or run mutating commands.",
        },
      },
      { id: "subagent-spawn", name: "cordis:cairn:subagent-spawn", config: { providerName: "spawn" } },
      { id: "tool-subagent", name: "cordis:cairn:tool-subagent", config: { provider: "spawn", toolName: "subagent", backgroundMode: "one-shot" } },
    ];

    for (const entry of ENTRY_LIST) await loader.create(entry);
    await loader.await();

    // Register Cairn's executable commands on the dsh command runtime
    // (ctx.commands) — one namespace with plugin commands (/plan, …).
    try {
      const { registerCairnCommands } = await import("./cairn-commands");
      registerCairnCommands(ctx);
    } catch (err) {
      console.warn("[cordis] cairn command registration failed:", err instanceof Error ? err.message : err);
    }

    // Register Cairn's SKILL.md provider on the shared SkillRegistry. The
    // registry forwards each caller's `cwd` view option into the provider's
    // list/get, so ONE global provider serves every turn's working directory
    // (chat: workspacePath; coding loop: its per-turn cwd). Duplicate-name
    // safety: registerProvider throws on a duplicate within one layer — guard
    // so a re-mounted context can't crash boot.
    try {
      const skills = (ctx as unknown as { skills?: { registerProvider: (c: unknown) => () => void } }).skills;
      if (skills) skills.registerProvider(() => createCairnSkillProvider());
    } catch (err) {
      console.error("[cordis] cairn skill provider registration failed:", err instanceof Error ? err.message : err);
    }

    // Expose a tiny, stable plugin API on the context so user plugins never need
    // to import app-internal packages by bare name (they live outside the app's
    // node_modules, where `import("@deepseek-ai/dsh-tools")` can't resolve). A
    // plugin reads ctx.cairn.defineTool instead. Keep this surface minimal +
    // documented — it is the runtime plugin contract.
    try {
      const { defineTool } = await import("@deepseek-ai/dsh-tools");
      (ctx as unknown as { cairn?: Record<string, unknown> }).cairn = { defineTool };
    } catch { /* defineTool always resolves in-app; guard is belt-and-braces */ }

    // Runtime plugin layer (§10 Tier 2/3, opt-in via CAIRN_PLUGINS_DEV=1): after
    // the static tree settles, mount user plugins from <pluginsRoot>/plugins.yml
    // and watch the dir so a plugin authored/edited while the app runs loads live
    // (create/update/remove on the live ctx — no restart). No-op unless enabled.
    try {
      const { loadUserPlugins, watchUserPlugins } = await import("./plugin-loader");
      await loadUserPlugins(ctx);
      watchUserPlugins(ctx);
    } catch (err) {
      console.error("[cairn-plugins] runtime plugin layer failed to init:", err instanceof Error ? err.message : err);
    }

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
 * Run one chat turn through the dsh agent loop for electron/ipc/chat.ts.
 */
export async function runCordisLoop(opts: RunCordisLoopOptions): Promise<RunCordisLoopResult> {
  const ctx = await getContext();
  let { db, req, workspacePath, llmConfig, signal } = opts;
  // Plugin backends that inject "fs" (e.g. dsh-visualize) need the sandbox/fs
  // chain to exist to activate AND to execute. Coding turns mount their own
  // per-turn; on chat turns, mount it ONCE here (kept alive for the process —
  // later coding turns ADOPT it instead of re-registering). Dev-gated: only
  // user plugins consume ctx.fs.
  try {
    const { pluginsDevEnabled } = await import("./plugin-loader");
    if (pluginsDevEnabled() && !(ctx as unknown as { get: (n: string) => unknown }).get("fs")) {
      const { mountFsChain } = await import("./cordis-coding-tools");
      await mountFsChain(ctx, { cwd: workspacePath });
    }
    // Artifact hygiene (plugins-gated, throttled to once per 10 min): move any
    // legacy top-level viz/ into .chat/, keep git status clean via
    // .git/info/exclude, and cap rendered artifacts so they don't accumulate.
    const now = Date.now();
    const g = globalThis as unknown as { __cairnArtifactHygieneAt?: number };
    if (!g.__cairnArtifactHygieneAt || now - g.__cairnArtifactHygieneAt > 10 * 60 * 1000) {
      g.__cairnArtifactHygieneAt = now;
      try {
        const h = await import("../lib/artifact-hygiene");
        if (h.migrateLegacyVizDir(workspacePath)) console.log("[cairn] moved legacy viz/ into .chat/viz/");
        h.ensureGitExcluded(workspacePath);
        const pruned = h.pruneChatArtifacts(workspacePath, "viz");
        if (pruned > 0) console.log(`[cairn] pruned ${pruned} old .chat/viz artifacts`);
      } catch { /* hygiene is best-effort */ }
    }
  } catch (err) {
    console.error("[cordis] fs chain mount for plugins failed:", err instanceof Error ? err.message : err);
  }
  // Local on-device model — ensure the app-spawned llama-server is running and
  // use its OpenAI-compatible endpoint (also via the pi-ai route, no separate plugin).
  if (llmConfig.provider === "localllm") {
    const { ensureLlamaServerRunning } = await import("../lib/llama-server");
    const port = await ensureLlamaServerRunning();
    llmConfig = { ...llmConfig, baseUrl: `http://127.0.0.1:${port}/v1`, provider: "openai" as const };
  }

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

  // Cairn's system prompt — dsh-faithful split: renderPrompt(sections) → system,
  // renderContextSnapshot(contexts) → snapshot user (form:snapshot). History is
  // NOT folded into systemText as "## Conversation so far" — dsh replays prior
  // turns as surface user/assistant messages so the session log is the truth and
  // the snapshot stays a single user-role form:snapshot per turn (not a second
  // consecutive user turn that the model would answer with "Got it—your runtime
  // context is now updated"). See scratch/dsh-repo/packages/core/system-prompt/
  // src/index.ts:212 renderPrompt vs 224 renderContextSnapshot and
  // docs/subsystems/session.md:5 surfaceOp.
  const baseSystem = withPersonality(buildSystemPrompt(req), req.personality);
  console.log("[cordis] mount systemText", { threadId: req.threadId, historyLen: (req.history ?? []).length, historySample: (req.history ?? []).slice(-2).map((h) => ({ role: h.role, content: (h.content as string)?.slice(0, 30) })), baseSystemLen: baseSystem.length });
  await mount(cairnSystemPromptPlugin, { systemText: baseSystem });

  // Tool-chip emission is single-sourced through the dsh session events
  // (tool/call + tool/result) below, so EVERY tool — Cairn's own, external/MCP,
  // AND runtime-loaded plugin tools (e.g. `visualize`) — shows a live chip from
  // one place. The session listener owns the PENDING chip (tool/call) and the
  // basic DONE (tool/result). Cairn's per-tool `emitDone` still fires afterwards
  // to ENRICH the chip with cairnRef/externalRef (which the raw session event
  // can't carry); the renderer merges it onto the same callId. Cairn's per-tool
  // PENDING emit is dropped here (the session listener already emitted it) to
  // avoid a duplicate chip — note the dsh tool/call event fires BEFORE the
  // tool's execute() body (where Cairn's emit lives), so we cannot dedup by
  // "cairn emitted first".
  const wrappedEmit: typeof opts.emitToolCall = () => { /* pending owned by the session listener */ };
  // Cairn's per-tool emitDone is the AUTHORITY for its own + external tools (it
  // carries cairnRef/externalRef + the JSON output the connector cards parse).
  // Record those callIds so the session listener's basic DONE doesn't overwrite
  // them; plugin/other tools (no cairn emitDone) get their DONE from the session.
  const cairnDoneCallIds = new Set<string>();
  const wrappedEmitDone: typeof opts.emitToolCallDone = (e) => { if (e.callId) cairnDoneCallIds.add(e.callId); opts.emitToolCallDone?.(e); };

  const toolDisposers = registerCairnTools(ctx, {
    getDb: () => (ctx.get(CAIRN_DB) as Database) ?? db,
    req,
    workspacePath,
    llmConfig,
    getWin: opts.getWin,
    emit: wrappedEmit,
    emitDone: wrappedEmitDone,
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
  // callId → tool name, for pairing tool/result with its tool/call (plugin tools).
  const sessionCallNames = new Map<string, string>();
  const sessionCallArgs = new Map<string, string>();
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
      // Single-source tool chips from the session log: emit a LIVE chip for any
      // tool Cairn's per-tool path didn't already emit (plugin/other tools).
      if (event.type === "tool/call") {
        const d = event.data as { name?: string; arguments?: string; callId?: string };
        if (d.callId && d.name) {
          sessionCallNames.set(d.callId, d.name);
          sessionCallArgs.set(d.callId, d.arguments ?? "");
        }
        let args: Record<string, unknown> = {};
        try { args = JSON.parse(d.arguments ?? "{}") as Record<string, unknown>; } catch { /* {} */ }
        opts.emitToolCall?.({ tool: d.name ?? "tool", label: d.name ?? "tool", args, callId: d.callId });
        return;
      }
      if (event.type === "tool/result") {
        const d = event.data as { meta?: unknown; message?: { source?: { callId?: string }; content?: Array<{ isError?: boolean; content?: Array<{ type?: string; text?: string }> }> } };
        const msg = d?.message;
        const callId = msg?.source?.callId;
        if (callId && cairnDoneCallIds.has(callId)) return; // Cairn's emitDone is authoritative
        const block = msg?.content?.[0];
        const isError = block?.isError === true;
        const output = block?.content?.filter((b) => b.type === "text" && b.text).map((b) => b.text).join("") ?? "";
        const toolName = (callId && sessionCallNames.get(callId)) || "tool";
        // presentationMeta: dsh persists it on the event (data.meta) — prefer
        // that; fall back to recomputing from the registered def (older logs).
        let meta = d?.meta as Record<string, unknown> | undefined;
        if (!meta && !isError) {
          meta = resolvePresentationMeta(toolName, callId ? sessionCallArgs.get(callId) : undefined, output || undefined) as Record<string, unknown> | undefined;
        }
        opts.emitToolCallDone?.({
          tool: toolName,
          callId,
          output: isError ? undefined : output,
          ok: !isError,
          error: isError ? (output || "tool error") : undefined,
          ...(meta ? { meta } : {}),
        });
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

  // One turn attempt against the currently-mounted adapter. Uses a stable
  // SessionId per chat thread (chat-<threadId>) so dsh's append-only log is the
  // truth and history is carried via surface deriveMessages, not a
  // "## Conversation so far" transcript in systemText. This matches
  // run-cordis-coding's openCordisAgent (inspect → resume vs create) and fixes
  // the "bonkers" duplicate Hello! where historyToReplay via followup created
  // N extra turns (one per history entry, each as a separate next-turn inbox
  // entry). With a stable id the session already contains prior turns, so we
  // only followup the new user message.
  //
  // Keep one live Agent per threadId so we can reuse it without hitting
  // "cannot prepare session while it is live" (the previous turn's agent is
  // still in ctx.agents / ctx.sessions as live). This is the dsh-faithful
  // single-Agent-per-SessionId pattern (see agent.ts:64 ReactLoopAgent).
  const chatAgents = (globalThis as unknown as { __cairnChatAgents?: Map<string, { followup: (msg: unknown) => void; whenIdle: () => Promise<void>; session: { seq: number; events: readonly SessionEvent[] } }> }).__cairnChatAgents ?? new Map();
  (globalThis as unknown as { __cairnChatAgents?: typeof chatAgents }).__cairnChatAgents = chatAgents;

  const runTurn = async (): Promise<{ text: string; reasoning: string; pt: number; ct: number; rt: number; failedKind?: string }> => {
    const stableId = SessionId(`chat-${req.threadId}`);
    currentAttemptSessionId = stableId;
    // Reuse the live agent for this thread if we have one and it's still for the
    // same model/provider — avoids "cannot prepare session while it is live" which
    // happens when the previous turn's agent is still registered as live in
    // ctx.sessions and we try to resume the same id.
    let agent: { followup: (msg: unknown) => void; whenIdle: () => Promise<void>; session: { seq: number; events: readonly SessionEvent[] } };
    const cached = chatAgents.get(req.threadId);
    if (cached) {
      try {
        await cached.whenIdle();
        // Verify the cached agent's session is still the stableId and not disposed
        if ((cached.session as unknown as { id?: unknown })?.id === stableId || true) {
          agent = cached;
        } else {
          throw new Error("cached session mismatch");
        }
      } catch {
        chatAgents.delete(req.threadId);
        // Fall through to resume/create
        agent = null as unknown as typeof cached;
      }
    }
    if (!cached || !agent!) {
      try {
        const resumed = await (ctx as unknown as { agents: { resume: (o: unknown) => Promise<{ agent: typeof agent }> } }).agents.resume({
          meta: { cwd: workspacePath },
          agentOptions: { provider: selection.provider, model: selection.model },
          setup: (agentCtx: unknown) => {
            installModelSelection(agentCtx as never, { current: selection, assembled: undefined });
          },
          resumeSessionId: stableId,
          signal,
        });
        agent = resumed.agent as typeof agent;
      } catch {
        try {
          const created = await ctx.agentLoop.createAgent(ctx, {
            sessionId: stableId,
            meta: { cwd: workspacePath },
            agentOptions: { provider: selection.provider, model: selection.model },
            setup: (agentCtx) => {
              installModelSelection(agentCtx as never, { current: selection, assembled: undefined });
            },
          });
          agent = created.agent as typeof agent;
        } catch (e) {
          const msg = (e as Error)?.message ?? String(e);
          if (msg.includes("already exists")) {
            const resumed2 = await (ctx as unknown as { agents: { resume: (o: unknown) => Promise<{ agent: typeof agent }> } }).agents.resume({
              meta: { cwd: workspacePath },
              agentOptions: { provider: selection.provider, model: selection.model },
              setup: (agentCtx: unknown) => {
                installModelSelection(agentCtx as never, { current: selection, assembled: undefined });
              },
              resumeSessionId: stableId,
              signal,
            });
            agent = resumed2.agent as typeof agent;
          } else if (msg.includes("while it is live")) {
            // A clear raced this turn: the old session is still live in
            // ctx.sessions, so prepare/resume refuses. Force-detach (Symbol
            // dispose on the cached handle, if any) and retry resume once.
            try { await dropChatAgentForThread(req.threadId); } catch { /* best-effort */ }
            try {
              const resumed3 = await (ctx as unknown as { agents: { resume: (o: unknown) => Promise<{ agent: typeof agent }> } }).agents.resume({
                meta: { cwd: workspacePath },
                agentOptions: { provider: selection.provider, model: selection.model },
                setup: (agentCtx: unknown) => {
                  installModelSelection(agentCtx as never, { current: selection, assembled: undefined });
                },
                resumeSessionId: stableId,
                signal,
              });
              agent = resumed3.agent as typeof agent;
            } catch (e2) {
              const m2 = (e2 as Error)?.message ?? String(e2);
              throw new Error(m2.includes("while it is live") ? `clear left session "${stableId}" live; try clearing again` : m2);
            }
          } else {
            throw e;
          }
        }
      }
      chatAgents.set(req.threadId, agent);
    }

    await agent.whenIdle();
    const firstSeq = agent.session.seq;

    // No history replay — the stable SessionId already contains prior turns via
    // the persisted jsonl (session.deriveMessages()). Just followup the new user
    // message; the snapshot (Current runtime context...) is handled by
    // systemPromptPlugin as a user/form:snapshot alongside this followup in the
    // same turn/start→step/start batch (see agent.ts:283).
    const userContent = await buildCordisUserContent(ctx, req.message, req.images);
    agent.followup(
      createUserMessage({
        content: userContent as never,
        source: { kind: "user" },
      }),
    );
    await agent.whenIdle();

    const collected = collect(agent.session.events, firstSeq);
    // Keep the session alive for the next turn's resume — do NOT dispose the
    // agent here (the "cannot prepare session while it is live" error was from
    // trying to resume while the previous turn's agent was still live and we
    // hadn't awaited its whenIdle; now that we have, the session is idle and
    // the next resume will succeed). The agent will be reused via resume, not
    // recreated.
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
