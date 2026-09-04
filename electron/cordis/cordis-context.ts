import { Context } from "@deepseek-ai/cordis";
import "./ctx-augment";
import Loader from "@deepseek-ai/cordis-plugin-loader";
import sessionPlugin from "@deepseek-ai/dsh-session";
import llmPlugin from "@deepseek-ai/dsh-llm";
import systemPromptPlugin from "@deepseek-ai/dsh-system-prompt";
import agentPlugin from "@deepseek-ai/dsh-agent";
import toolsPlugin from "@deepseek-ai/dsh-tools";
import agentLoopPlugin from "@deepseek-ai/dsh-agent-loop";
import subagentServicePlugin from "@deepseek-ai/dsh-subagent";
import userQuestionsService from "@deepseek-ai/dsh-user-questions";
import { apply as spawnProviderApply, inject as spawnProviderInject, name as spawnProviderName } from "@deepseek-ai/dsh-subagent-spawn-in-process";
import { apply as toolSubagentApply, inject as toolSubagentInject, name as toolSubagentName } from "@deepseek-ai/dsh-tool-subagent";
import { apply as toolSubagentControlApply, inject as toolSubagentControlInject, name as toolSubagentControlName } from "@deepseek-ai/dsh-tool-subagent-control";
import { apply as toolSubagentListAgentsApply, inject as toolSubagentListAgentsInject, name as toolSubagentListAgentsName } from "@deepseek-ai/dsh-tool-subagent-control/list-agents";
import JobsLocal from "@deepseek-ai/dsh-jobs-local";
import { apply as toolJobsApply, inject as toolJobsInject, name as toolJobsName } from "@deepseek-ai/dsh-tool-jobs";
import TerminalSessionService from "@deepseek-ai/dsh-terminal";
import JsonlSessionPersistence from "@deepseek-ai/dsh-session-persistence-jsonl";
import SessionQuerySqlite from "@deepseek-ai/dsh-session-query-sqlite";
import approvalService from "@deepseek-ai/dsh-user-approval";
import TokenMeter from "@deepseek-ai/dsh-token-meter";
import ToolResultPruner from "@deepseek-ai/dsh-compaction-tool-result-pruner";
import BasicCompactionEngine from "@deepseek-ai/dsh-compaction-basic";
import SkillRegistry from "@deepseek-ai/dsh-skill";
import { apply as skillFilesystemApply, inject as skillFilesystemInject, name as skillFilesystemName } from "@deepseek-ai/dsh-skill-filesystem";
import InvariantRegistry from "@deepseek-ai/dsh-invariants";
import CommandRuntime from "@deepseek-ai/dsh-commands";
import planModePlugin from "@deepseek-ai/dsh-plan-mode";
import { apply as toolSkillApply, inject as toolSkillInject, name as toolSkillName } from "@deepseek-ai/dsh-tool-skill";
import { apply as llmRetryApply, inject as llmRetryInject, name as llmRetryName } from "@deepseek-ai/dsh-llm-retry";
import { apply as commandCompactApply, inject as commandCompactInject, name as commandCompactName } from "@deepseek-ai/dsh-command-compact";
import SessionTitleService from "@deepseek-ai/dsh-session-title";
import { apply as sessionStatsApply, inject as sessionStatsInject, name as sessionStatsName } from "@deepseek-ai/dsh-session-stats";
import PermissionPresetService from "@deepseek-ai/dsh-permission-presets";
import GoalService from "@deepseek-ai/dsh-goal";
import { apply as toolGoalApply, inject as toolGoalInject, name as toolGoalName } from "@deepseek-ai/dsh-tool-goal";
import { apply as commandGoalApply, inject as commandGoalInject, name as commandGoalName } from "@deepseek-ai/dsh-command-goal";
import { apply as goalRoundDriverApply, inject as goalRoundDriverInject, name as goalRoundDriverName } from "@deepseek-ai/dsh-goal-round-driver";
import StorageHub from "@deepseek-ai/dsh-storage";
import { apply as storageJsonApply, inject as storageJsonInject, name as storageJsonName } from "@deepseek-ai/dsh-storage-json";
import { apply as storageDomainApply, inject as storageDomainInject, name as storageDomainName } from "@deepseek-ai/dsh-storage-domain";
import MessageFeedbackService from "@deepseek-ai/dsh-message-feedback";
import { apply as commandFeedbackApply, inject as commandFeedbackInject, name as commandFeedbackName } from "@deepseek-ai/dsh-command-feedback";
import { apply as scheduleApply, inject as scheduleInject, name as scheduleName } from "@deepseek-ai/dsh-schedule";
import { isScheduleEnabled as hostIsScheduleEnabled, resolveHooksConfig } from "./host-store";
import { apply as firstPromptApply, inject as firstPromptInject, name as firstPromptName } from "@deepseek-ai/dsh-session-title-first-prompt-llm";
import { CairnAttachmentStore } from "./cairn-attachment-store";
import { LocalSpillStore } from "@deepseek-ai/dsh-spill-local";
import * as SpillPolicy from "@deepseek-ai/dsh-spill-policy";
import { app as electronApp } from "electron";
import path from "path";
import os from "os";
import { createCairnSkillProvider } from "./cairn-skill-provider";
import { peekChatAgentCache } from "./chat-agent-cache";
import { SessionId } from "@deepseek-ai/dsh-session";
import WebRuntime from "@deepseek-ai/dsh-web";
import { apply as webFetchHttpApply, inject as webFetchHttpInject, name as webFetchHttpName } from "@deepseek-ai/dsh-web-fetch-http";
import { apply as toolWebApply, inject as toolWebInject, name as toolWebName } from "@deepseek-ai/dsh-tool-web";
import WorkerThreadWorkflowEngine from "@deepseek-ai/dsh-workflow-worker-thread";
import { apply as sessionExportApply, inject as sessionExportInject, name as sessionExportName } from "./session-export";

let sharedCtx: Context | null = null;
let contextReady: Promise<Context> | null = null;
let sessionRoot = process.env.CAIRN_SESSION_ROOT || path.join(process.cwd(), ".cairn-sessions");

export function getSessionRoot(): string { return sessionRoot; }
export function setSessionRoot(root: string): void {
  if (sharedCtx || contextReady) {
    console.warn(`[cordis] setSessionRoot("${root}") called after context creation — new root will only take effect after restart (current root: "${sessionRoot}")`);
  }
  sessionRoot = root;
}
export function __resetContextForTest(): void {
  sharedCtx = null;
  contextReady = null;
}

/**
 * Root directory for the message-feedback JSON storage backend (one
 * `message_feedback` unit file). Production persists under userData next to
 * the spill store; vitest uses a per-process tmp dir (parallel workers must
 * not contend on one shared file — same rationale as the `:memory:`
 * session-query index above).
 */
function feedbackStorageRoot(): string {
  if (process.env.VITEST) return path.join(os.tmpdir(), `cairn-feedback-storage-${process.pid}`);
  return path.join(process.env.CAIRN_USER_DATA_DIR || electronApp?.getPath?.("userData") || process.cwd(), "feedback-storage");
}

/**
 * Whether the opt-in dsh schedule overlay (session-local reminders) mounts.
 * Reads the persisted agent setting (`schedule.enabled`, default OFF). The
 * context builds once per process, so toggling the setting needs an app
 * restart — the Settings toggle says so. Exported for unit tests.
 */
export function isScheduleEnabled(): boolean {
  return hostIsScheduleEnabled();
}

export async function getContext(): Promise<Context> {
  if (sharedCtx) return sharedCtx;
  if (contextReady) return contextReady;
  contextReady = (async () => {
    const ctx = new Context();
    await ctx.plugin(Loader);
    const loader = ctx.loader as unknown as {
      builtins: Record<string, unknown>;
      create: (o: Record<string, unknown>) => Promise<unknown>;
      await: () => Promise<void>;
    };
    loader.builtins ??= {};
    const B = loader.builtins;
    B["dsh:session"] = sessionPlugin;
    B["dsh:llm"] = llmPlugin;
    B["dsh:system-prompt"] = systemPromptPlugin;
    B["dsh:agent"] = agentPlugin;
    B["dsh:tools"] = toolsPlugin;
    B["dsh:user-questions"] = userQuestionsService;
    B["dsh:approval"] = approvalService;
    B["dsh:session-persistence"] = JsonlSessionPersistence;
    B["dsh:session-query-sqlite"] = SessionQuerySqlite;
    B["dsh:agent-loop"] = agentLoopPlugin;
    B["dsh:token-meter"] = TokenMeter;
    B["dsh:tool-result-pruner"] = ToolResultPruner;
    B["dsh:compaction"] = BasicCompactionEngine;
    B["dsh:subagent"] = subagentServicePlugin;
    B["dsh:skills"] = SkillRegistry;
    B["dsh:skill-filesystem"] = { apply: skillFilesystemApply, inject: skillFilesystemInject, name: skillFilesystemName };
    B["dsh:invariants"] = InvariantRegistry;
    B["dsh:tool-skill"] = { apply: toolSkillApply, inject: toolSkillInject, name: toolSkillName };
    B["dsh:commands"] = CommandRuntime;
    B["dsh:plan-mode"] = planModePlugin;
    B["cairn:attachment-store"] = CairnAttachmentStore;
    B["dsh:spill"] = LocalSpillStore;
    B["dsh:spill-policy"] = SpillPolicy;
    B["cairn:llm-retry"] = { apply: llmRetryApply, inject: llmRetryInject, name: llmRetryName };
    B["cairn:subagent-spawn"] = { apply: spawnProviderApply, inject: spawnProviderInject, name: spawnProviderName };
    B["cairn:tool-subagent"] = { apply: toolSubagentApply, inject: toolSubagentInject, name: toolSubagentName };
    // Second instance of the same delegation plugin for continuable children
    // (separate builtin key so the loader composes it independently).
    B["cairn:tool-subagent-continuable"] = { apply: toolSubagentApply, inject: toolSubagentInject, name: toolSubagentName };
    B["cairn:tool-subagent-control"] = { apply: toolSubagentControlApply, inject: toolSubagentControlInject, name: toolSubagentControlName };
    B["cairn:tool-subagent-list-agents"] = { apply: toolSubagentListAgentsApply, inject: toolSubagentListAgentsInject, name: toolSubagentListAgentsName };
    B["dsh:jobs-local"] = JobsLocal;
    B["cairn:tool-jobs"] = { apply: toolJobsApply, inject: toolJobsInject, name: toolJobsName };
    // Owner-scoped persistent PTY registry (`ctx.terminals`). A bare Service
    // with no injected deps, so it composes as a loader entry like
    // `dsh:session` (no per-turn service involved — backends register
    // per coding turn, see `cordis-coding-tools.ts`). Owns ids,
    // publication, authorization, and awaited cleanup; kill at turn/app end
    // flows through it (see `terminal-backend.ts` header + sandbox review).
    B["dsh:terminal"] = TerminalSessionService;
    // Per-message feedback sidecar chain (dsh-message-feedback injects
    // storageDomain + sessionPersistence + sessions — all ENTRY_LIST-resident,
    // so the whole chain composes as loader entries in dependency order;
    // no per-turn service is involved). JSON backend (pure fs, no native
    // binding) over the storage hub + domain facility, then the feedback
    // service (maxNoteBytes 8192, matching the upstream Web bundle) and the
    // log-only /feedback command (injects only `commands`).
    B["dsh:storage"] = StorageHub;
    B["dsh:storage-json"] = { apply: storageJsonApply, inject: storageJsonInject, name: storageJsonName };
    B["dsh:storage-domain"] = { apply: storageDomainApply, inject: storageDomainInject, name: storageDomainName };
    B["dsh:message-feedback"] = MessageFeedbackService;
    B["dsh:command-feedback"] = { apply: commandFeedbackApply, inject: commandFeedbackInject, name: commandFeedbackName };
    // Opt-in schedule overlay (always registered as a builtin so the entry
    // below can reference it; whether it MOUNTS is gated by the setting).
    // dsh-schedule injects only agents/sessions/tools/sessionPersistence —
    // all ENTRY_LIST-resident, never per-turn — so it composes as a loader
    // entry. No dsh-time-context: time_zone is a model-supplied IANA string
    // validated inside the schedule domain (Intl), not a service.
    B["dsh:schedule"] = { apply: scheduleApply, inject: scheduleInject, name: scheduleName };
    // Web research stack (dsh-web seam + providers + model tools). All three
    // layers inject only ENTRY_LIST-resident services (tools/web/systemPrompt),
    // so the whole stack composes as loader entries in dependency order.
    B["dsh:web"] = WebRuntime;
    B["dsh:web-fetch-http"] = { apply: webFetchHttpApply, inject: webFetchHttpInject, name: webFetchHttpName };
    B["dsh:tool-web"] = { apply: toolWebApply, inject: toolWebInject, name: toolWebName };
    // Workflow seam: the worker-thread engine is a Service with
    // `static inject = ['subagents']` (ENTRY_LIST-resident), so it composes as
    // a loader entry like `dsh:terminal`. The model tools (tool-workflow /
    // tool-ralph) mount per CODING turn instead — see mountCodingStack.
    B["dsh:workflow-engine"] = WorkerThreadWorkflowEngine;
    // Session-log export trigger. Cairn-owned shim (not the upstream plugin:
    // that one injects the web shell's `connection` service, which Electron
    // does not have — see session-export.ts). Injects only `commands`.
    B["cairn:session-export"] = { apply: sessionExportApply, inject: sessionExportInject, name: sessionExportName };
    B["dsh:command-compact"] = { apply: commandCompactApply, inject: commandCompactInject, name: commandCompactName };
    B["dsh:session-title"] = SessionTitleService;
    B["dsh:session-title-first-prompt-llm"] = { apply: firstPromptApply, inject: firstPromptInject, name: firstPromptName };
    // Alias for task description shorthand — same plugin under the shorter key.
    B["dsh:session-title-llm"] = { apply: firstPromptApply, inject: firstPromptInject, name: firstPromptName };
    const entries: Array<Record<string, unknown>> = [
      { id: "session", name: "cordis:dsh:session" },
      { id: "llm", name: "cordis:dsh:llm" },
      { id: "system-prompt", name: "cordis:dsh:system-prompt", config: { persona: "", includeHarnessIdentity: false } },
      { id: "agent", name: "cordis:dsh:agent" },
      { id: "tools", name: "cordis:dsh:tools", config: { mode: "native" } },
      { id: "user-questions", name: "cordis:dsh:user-questions" },
      { id: "approval", name: "cordis:dsh:approval", config: { policy: "ask" } },
      { id: "session-persistence", name: "cordis:dsh:session-persistence", config: { root: sessionRoot } },
      // Session query backend (dsh 0.1.2-alpha.4+): continuable subagent
      // cold-resume + listChildren go through `ctx.sessionQuery` — without a
      // backend they fail closed (CONTINUATION_UNAVAILABLE). node:sqlite only,
      // no native binding. Under vitest the index is `:memory:` (private per
      // context — parallel workers would otherwise contend on one shared file
      // → "database is locked"); exact reads/filters/traces are unaffected,
      // only FTS persistence is lost, which no test needs. Production keeps a
      // derived FTS index next to the session logs.
      { id: "session-query-sqlite", name: "cordis:dsh:session-query-sqlite", config: { path: process.env.VITEST ? ":memory:" : path.join(path.dirname(sessionRoot), "session-search.db") } },
      { id: "agent-loop", name: "cordis:dsh:agent-loop", config: { agents: [] } },
      // Cairn-owned sharp-free store (in-memory, context lifetime). Upstream's
      // LocalAttachmentStore needs real sharp (stubbed repo-wide), so it is
      // not mounted. No config — the store takes none.
      { id: "attachment-store", name: "cordis:cairn:attachment-store", config: {} },
      { id: "spill", name: "cordis:dsh:spill", config: { root: path.join(process.env.CAIRN_USER_DATA_DIR || electronApp?.getPath?.("userData") || process.cwd(), "spill") } },
      { id: "spill-policy", name: "cordis:dsh:spill-policy", config: { maxInlineBytes: 32768 } },
      { id: "token-meter", name: "cordis:dsh:token-meter" },
      { id: "tool-result-pruner", name: "cordis:dsh:tool-result-pruner" },
      { id: "compaction", name: "cordis:dsh:compaction", config: { auto: true, thresholdRatio: 0.8 } },
      // Session-title service (log-backed fallback) + first-prompt LLM provider.
      // The provider omits provider/model so it inherits the chat route's exact
      // logged request/header — no separate title model; the chat model titles.
      { id: "session-title", name: "cordis:dsh:session-title", config: { fallbackMaxWords: 5, fallbackMaxBytes: 40, maxTitleBytes: 80 } },
      { id: "session-title-first-prompt", name: "cordis:dsh:session-title-first-prompt-llm", config: { targetWords: 5, targetCjkCharacters: 10, maxInputBytes: 4096, maxOutputTokens: 32, timeoutMs: 10000 } },
      { id: "llm-retry", name: "cordis:cairn:llm-retry", config: {} },
      { id: "subagent", name: "cordis:dsh:subagent" },
      { id: "skills", name: "cordis:dsh:skills" },
      // Local-filesystem skill discovery (dsh-skill-filesystem) as an ADDITIVE
      // backend behind the skill seam: it covers the dsh-conventional project
      // roots (<project>/.dsh/skills, <project>/.agents/skills) + user roots
      // (~/.dsh/skills, ~/.agents/skills) with chokidar watching +
      // registry invalidation, alongside Cairn's own provider (registered
      // below, which keeps serving .cairn/.opencode/.cline/.claude + globals
      // unchanged). Overlap note: a name present in .agents/skills is listed
      // by BOTH providers; the registry resolves duplicates by rank (lower
      // wins), so the dsh entry (project-agents rank 200) wins over Cairn's
      // (bundled rank 600) — same file, near-identical parse; pinned in
      // skill-filesystem.test.ts. Watching is OFF under vitest (persistent
      // chokidar handles would leak across the shared test context — same
      // rationale as the :memory: session-query index above); production
      // watches with the upstream defaults.
      {
        id: "skill-filesystem",
        name: "cordis:dsh:skill-filesystem",
        config: { providerName: "dsh-filesystem", includeDefaultRoots: true, watch: !process.env.VITEST },
      },
      { id: "invariants", name: "cordis:dsh:invariants" },
      { id: "tool-skill", name: "cordis:dsh:tool-skill" },
      { id: "commands", name: "cordis:dsh:commands" },
      { id: "command-compact", name: "cordis:dsh:command-compact" },
      { id: "plan-mode", name: "cordis:dsh:plan-mode", config: { section: "You are in plan mode. Stay in plan mode until the user switches the session mode. Explore and read first; do not edit files or run mutating commands." } },
      { id: "subagent-spawn", name: "cordis:cairn:subagent-spawn", config: { providerName: "spawn" } },
      { id: "tool-subagent", name: "cordis:cairn:tool-subagent", config: { provider: "spawn", toolName: "subagent", backgroundMode: "one-shot" } },
      // Continuable delegation: background runs return a durable child id the
      // model (send_message) or the user (subagent:message IPC) can message
      // later. Kept as a separate tool so one-shot `subagent` keeps its
      // wait-for-result contract. Requires the provider's prepareContinuable
      // capability (spawn has it).
      { id: "tool-subagent-continuable", name: "cordis:cairn:tool-subagent-continuable", config: { provider: "spawn", toolName: "delegate", backgroundMode: "continuable" } },
      // Model-facing continuable-child controls over ctx.subagents.
      { id: "tool-subagent-control", name: "cordis:cairn:tool-subagent-control", config: {} },
      { id: "tool-subagent-list-agents", name: "cordis:cairn:tool-subagent-list-agents", config: {} },
      // Background-job registry + model controls (job_output/job_list/job_kill
      // + settlement notices). Required by BOTH background routes: one-shot
      // run_in_background AND continuable delegate — without a controller,
      // background starts fail with "background jobs unavailable".
      { id: "jobs-local", name: "cordis:dsh:jobs-local", config: {} },
      { id: "tool-jobs", name: "cordis:cairn:tool-jobs", config: {} },
      // Persistent-shell registry for the coding stack's per-turn backend.
      // ENTRY_LIST-resident (no injects) so `tool-terminal`'s per-turn
      // `terminals` inject always resolves; the backend itself mounts per
      // coding turn only (never chat) — see `mountCodingStack`.
      { id: "terminals", name: "cordis:dsh:terminal", config: {} },
      // Per-message feedback sidecar (see B-map comment above). Order matters:
      // hub → backend → domain facility → feedback service → /feedback command.
      { id: "storage", name: "cordis:dsh:storage" },
      { id: "storage-json", name: "cordis:dsh:storage-json", config: { root: feedbackStorageRoot() } },
      { id: "storage-domain", name: "cordis:dsh:storage-domain", config: { backend: "json" } },
      { id: "message-feedback", name: "cordis:dsh:message-feedback", config: { maxNoteBytes: 8192 } },
      { id: "command-feedback", name: "cordis:dsh:command-feedback" },
      // Opt-in schedule overlay (session-local reminders — explicitly NOT
      // Cairn's own heartbeat in electron/lib/heartbeat-*, untouched).
      // LOAD-ORDER RULE (upstream): schedule installs only for root agents
      // published AFTER the plugin loads — sessions created before the
      // overlay lack schedule_* tools. Position here is safe because EVERY
      // entry (including this one) resolves before getContext() returns, and
      // sessions only open per-turn afterwards — so when enabled, every
      // session sees the tools; when disabled, no session does. Gated by
      // isScheduleEnabled() (restart to apply).
      ...(isScheduleEnabled() ? [{ id: "schedule", name: "cordis:dsh:schedule" }] : []),
      // Web research stack (dsh-product-decisions "Web research stack"):
      // first-party cited answers in notes without a connector. Shared ctx
      // (not coding-only): web research serves notes research in chat AND
      // coding turns, and every inject is global — same precedent as the
      // ENTRY_LIST-mounted tool-skill / tool-goal / tool-jobs model tools.
      // Fetch-only by decision (no keyless search exists in dsh — every
      // search provider bills an API key; connectors cover assembled search):
      // anonymous local fetch needs no key and complements connectors for raw
      // URL retrieval. `search: false` unregisters web_search entirely rather
      // than leaving a cleanly-erroring dead tool in the model's list.
      // Approval: web_fetch is locked WRITE_LOCAL in shared/agent/tool-risk
      // → ask every call. Correct for v1 (untrusted external content must
      // stay an explicit decision).
      { id: "web", name: "cordis:dsh:web", config: { fetchProvider: "http" } },
      // Explicit limits mirror the package defaults (the B-map triplet carries
      // no Config schema, so the loader cannot default them — same reason the
      // coding stack passes full configs per turn).
      { id: "web-fetch-http", name: "cordis:dsh:web-fetch-http", config: { maxResponseBytes: 5_000_000, maxBodyChars: 100_000, timeoutMs: 30_000, maxRedirects: 5, userAgent: "deepseek-harness/0.0.1 (+https://github.com/deepseek-ai)" } },
      { id: "tool-web", name: "cordis:dsh:tool-web", config: { search: false, fetch: true, searchMaxResults: 8, searchMaxQueries: 4, fetchTimeoutMs: 30_000, searchTimeoutMs: 30_000, fetchMaxOutputChars: 200_000 } },
      // Workflow engine seam (dsh-product-decisions "Workflows + Ralph"): JS
      // orchestration scripts fanning out subagents. Engine only — the
      // workflow/ralph model tools mount per coding turn in mountCodingStack.
      // Config mirrors the package defaults: `provider: "spawn"` is Cairn's
      // in-process child route; maxTotalAgents 1000 is the runaway-loop
      // backstop (pinned in workflow-ralph.test.ts).
      { id: "workflow-engine", name: "cordis:dsh:workflow-engine", config: { provider: "spawn", maxConcurrentAgents: 0, maxTotalAgents: 1000, maxItemsPerCall: 4096, syncTimeoutMs: 5000, disposeGraceMs: 5000 } },
      // Session-log export trigger (dsh-product-decisions "Session-log
      // export"): the `/export` command writing a ZIP to disk. Surfaces via
      // the existing cordis:listCommands merge (palette/command input) with
      // no renderer changes. No config — the command takes none.
      { id: "session-export", name: "cordis:cairn:session-export", config: {} },
    ];
    for (const entry of entries) await loader.create(entry);
    await loader.await();
    // Thin pre-step: ensure the summariser adapter is pinned to the current
    // provider's apiMode before any manual compaction. Upstream
    // dsh-command-compact calls ctx.compaction.compactNow(agent) as-is with no
    // per-turn resolution; eager mount in openCordisSessionAgent covers
    // creation/resume, but a provider switch between turns would leave the
    // cached live chat agent stale — patching here makes /compact idempotent.
    try {
      const comp = ctx.compaction as { compactNow?: (...args: unknown[]) => Promise<unknown> } | undefined;
      if (comp?.compactNow) {
        const orig = comp.compactNow.bind(comp);
        (comp as { compactNow: typeof orig }).compactNow = async (...args: unknown[]) => {
          try {
            const { getCachedConfig } = await import("./host-store");
            const { ensureAgentAiAdapter } = await import("./session-runtime");
            const cached = getCachedConfig();
            const cfg = (cached as { agentConfig?: { baseUrl?: string; model?: string; apiKey?: string; activeProviderId?: string; contextWindow?: number; maxTokens?: number; reasoning?: boolean; isReasoningModel?: boolean } }).agentConfig ?? {};
            const providers = (cached as { aiConfig?: { savedProviders?: Array<{ id: string; apiMode?: string }> } }).aiConfig?.savedProviders;
            const apiMode = providers?.find((p) => p.id === (cfg as { activeProviderId?: string }).activeProviderId)?.apiMode as ("responses" | "completions" | "anthropic-messages" | undefined);
            const api = apiMode === "responses" ? "openai-responses" as const : apiMode === "anthropic-messages" ? "anthropic-messages" as const : "openai-completions" as const;
            if (cfg.baseUrl && cfg.model) {
              await ensureAgentAiAdapter(ctx, {
                baseUrl: cfg.baseUrl,
                model: cfg.model,
                apiKey: (cfg as { apiKey?: string }).apiKey ?? "",
                api,
                contextWindow: (cfg as { contextWindow?: number }).contextWindow,
                maxTokens: (cfg as { maxTokens?: number }).maxTokens,
                reasoning: (cfg as { reasoning?: boolean }).reasoning ?? (cfg as { isReasoningModel?: boolean }).isReasoningModel,
              });
            }
          } catch { /* best-effort */ }
          return orig(...(args as [never, never, never]));
        };
      }
    } catch { /* best-effort */ }
    try { if (ctx.skills) ctx.skills.registerProvider(() => createCairnSkillProvider()); } catch (err) { console.error("[cordis] cairn skill provider registration failed:", err instanceof Error ? err.message : err); }
    try { const { defineTool } = await import("@deepseek-ai/dsh-tools"); ctx.cairn = { defineTool, confirm: async (sessionId, req, opts) => { const { getConfirmTransport } = await import("./approval-transports"); const transport = getConfirmTransport(sessionId); if (!transport) return "cancelled" as const; return transport.confirm({ ...req, signal: opts?.signal }); } }; } catch { /* best-effort */ }
    try { const { default: ProjectionRegistry } = await import("@deepseek-ai/dsh-session-projection"); (ctx.plugin as (p: unknown, c?: unknown) => unknown)(ProjectionRegistry, {}); } catch (err) { console.warn("[cordis] session projections unavailable:", err instanceof Error ? err.message : err); }
    // Whole-log turn/step counts + LLM/tool/first-token/decode wall times
    // (`sessionStats` unit). Mounted post-bootstrap, NOT an ENTRY_LIST entry:
    // it injects only `sessionProjections`, which mounts post-bootstrap on the
    // line above — as a loader entry it would stall `loader.await()`. Awaited
    // (like the goal stack below) so the unit is registered before the first
    // session opens. Billing still reads SQLite `llm_usage` (token-meter stays
    // mounted but unused for billing) — this unit only feeds the stats line.
    try {
      const plug = ctx.plugin as unknown as (p: unknown, c?: unknown) => Promise<unknown>;
      await plug({ apply: sessionStatsApply, inject: sessionStatsInject, name: sessionStatsName }, {});
    } catch (err) { console.warn("[cordis] session stats unavailable:", err instanceof Error ? err.message : err); }
    // Permission presets (workspace-write, danger-full-access + /permission).
    // Mounted post-bootstrap, NOT an ENTRY_LIST entry: it injects `shell`,
    // which is only mounted per-turn by the coding stack — as a loader entry
    // it would stall `loader.await()` forever at bootstrap. Static import so a
    // missing/broken package fails loudly at bundle time instead of degrading
    // to a "permission presets unavailable" warning at runtime.
    try { (ctx.plugin as (p: unknown, c?: unknown) => unknown)(PermissionPresetService, {}); } catch (err) { console.warn("[cordis] permission presets unavailable:", err instanceof Error ? err.message : err); }
    // Same-session goals (dsh-goal service + get_goal/create_goal/update_goal
    // tools + /goal command + automatic goal-round driver). Mounted
    // post-bootstrap for the same reason: GoalService injects
    // `sessionProjections`, which only exists after the ProjectionRegistry
    // mount two lines above — as ENTRY_LIST entries the goal stack would
    // stall `loader.await()`. Mounted in dependency order (service → tools →
    // command → driver) and awaited so `ctx.goals` is live before the first
    // session opens. Static imports so a missing package fails at bundle time.
    try {
      const plug = ctx.plugin as unknown as (p: unknown, c?: unknown) => Promise<unknown>;
      await plug(GoalService, {});
      await plug({ apply: toolGoalApply, inject: toolGoalInject, name: toolGoalName }, {});
      await plug({ apply: commandGoalApply, inject: commandGoalInject, name: commandGoalName }, {});
      await plug({ apply: goalRoundDriverApply, inject: goalRoundDriverInject, name: goalRoundDriverName }, {});
    } catch (err) { console.warn("[cordis] goals unavailable:", err instanceof Error ? err.message : err); }
    try { const { mountContextRing } = await import("./plugins/context-ring"); mountContextRing(ctx); } catch (err) { console.warn("[cordis] context ring unavailable:", err instanceof Error ? err.message : err); }
    try { const { mountWorkspaceContext } = await import("./plugins/workspace-context"); mountWorkspaceContext(ctx); } catch (err) { console.warn("[cordis] workspace context unavailable:", err instanceof Error ? err.message : err); }
    try { const { mountSessionTitleBridge } = await import("./plugins/session-title"); mountSessionTitleBridge(ctx); } catch (err) { console.warn("[cordis] session-title bridge unavailable:", err instanceof Error ? err.message : err); }
    try { const { mountPruneGuard } = await import("./prune-hook"); mountPruneGuard(ctx); } catch (err) { console.warn("[cordis] prune guard unavailable:", err instanceof Error ? err.message : err); }
    try { const { mountSessionDurability } = await import("./plugins/session-durability"); mountSessionDurability(ctx); } catch (err) { console.warn("[cordis] session durability unavailable:", err instanceof Error ? err.message : err); }
    try { const { loadUserPlugins, watchUserPlugins } = await import("./plugin-loader"); await loadUserPlugins(ctx); watchUserPlugins(ctx); } catch (err) { console.error("[cairn-plugins] runtime plugin layer failed to init:", err instanceof Error ? err.message : err); }
    // Background-job UI bridge: ctx.jobs change/completion → session:projection
    // kind:"jobs" for the renderer dock. Singleton-subscribed (idempotent).
    try { const { mountJobsBridge } = await import("./jobs-bridge"); mountJobsBridge(ctx); } catch (err) { console.warn("[cordis] jobs bridge unavailable:", err instanceof Error ? err.message : err); }
    // Goal UI bridge: goal/changed → session:projection kind:"goal" for the
    // renderer goal chip. Mounted after the goal stack above (no-op without it).
    try { const { mountGoalBridge } = await import("./goal-bridge"); mountGoalBridge(ctx); } catch (err) { console.warn("[cordis] goal bridge unavailable:", err instanceof Error ? err.message : err); }
    // Permissions UI bridge: `permissions` projection change feed →
    // session:projection kind:"permissions" for the renderer preset switcher.
    // Mounted after the permission-presets service above (no-op without it).
    try { const { mountPermissionsBridge } = await import("./permissions-bridge"); mountPermissionsBridge(ctx); } catch (err) { console.warn("[cordis] permissions bridge unavailable:", err instanceof Error ? err.message : err); }
    // Community hook interop (Claude Code / Codex command hooks on dsh
    // interception seams — see hooks-bridge.ts for the config surface).
    // Mounted post-bootstrap, NOT an ENTRY_LIST entry: both bridges inject
    // `shell`, which is only mounted per-turn by the coding stack — as loader
    // entries they would stall `loader.await()` forever at bootstrap (same
    // reason as PermissionPresetService above). Disabled by default:
    // mountCairnHooks mounts nothing unless the user has hook config files.
    // Static dsh imports live in hooks-bridge.ts so a missing package fails
    // loudly at bundle time instead of degrading to this warning.
    try { const { mountCairnHooks } = await import("./hooks-bridge"); mountCairnHooks(ctx, resolveHooksConfig()); } catch (err) { console.warn("[cordis] hooks unavailable:", err instanceof Error ? err.message : err); }
    sharedCtx = ctx;
    return ctx;
  })();
  return contextReady;
}

export async function dropChatAgentForThread(threadId: string): Promise<void> {
  const map = peekChatAgentCache();
  if (map) {
    const entry = map.get(threadId) as { handle?: Record<PropertyKey, unknown>; agent?: Record<PropertyKey, unknown>; whenIdle?: () => Promise<void>; selectionRef?: unknown } | undefined;
    if (entry) {
      map.delete(threadId);
      // Prefer handle.dispose (AgentHandle owns the retirement capability via FactoryOwnership).
      // Fall back to agent disposal; cover Symbol.asyncDispose first (dsh's preferred).
      const candidates: Array<Record<PropertyKey, unknown>> = [];
      if (entry.handle) candidates.push(entry.handle, entry.handle);
      if (entry.agent) candidates.push(entry.agent);
      // entry itself may be the handle in older cache shapes
      if (entry !== entry.handle && entry !== entry.agent) candidates.push(entry as unknown as Record<PropertyKey, unknown>);
      // Wait for idle before dispose (compaction may be draining).
      try {
        const idle = (entry.whenIdle ?? (entry.agent as Record<PropertyKey, unknown> | undefined)?.whenIdle ?? (entry.handle as Record<PropertyKey, unknown> | undefined)?.whenIdle) as (() => Promise<void>) | undefined;
        if (typeof idle === "function") await idle.call(entry.agent ?? entry.handle ?? entry);
      } catch { /* best-effort */ }
      const seen = new Set<Record<PropertyKey, unknown>>();
      for (const obj of candidates) {
        if (!obj || seen.has(obj)) continue;
        seen.add(obj);
        let disposed = false;
        for (const key of [Symbol.asyncDispose, Symbol.dispose, "dispose", "close", "abort"] as const) {
          try {
            const fn = (obj as Record<PropertyKey, unknown>)[key] as (() => unknown) | undefined;
            if (typeof fn === "function") { await fn.call(obj); disposed = true; break; }
          } catch { /* best-effort */ }
        }
        if (disposed) break;
      }
    }
  }
  try {
    const ctx = await getContext();
    const sid = SessionId(`chat-${threadId}`);
    const session = ctx.sessions?.get?.(sid) as { [Symbol.dispose]?: () => void; dispose?: () => void } | undefined;
    session?.[Symbol.dispose]?.();
    (session as { dispose?: () => void })?.dispose?.();
    // Wait for coordinator retirement to quiescence — prepare checks ctx.sessions.get(sid)
    const start = Date.now();
    while (Date.now() - start < 3000) {
      if (!ctx.sessions.get(sid)) break;
      await new Promise((r) => setTimeout(r, 20));
    }
  } catch { /* best-effort */ }
}

const toolDefsByName = new Map<string, Record<string, unknown>>();
export function __setToolDefForTest(name: string, def: Record<string, unknown> | undefined): void {
  if (def) toolDefsByName.set(name, def);
  else toolDefsByName.delete(name);
}
function toolDefByName(tool: string): Record<string, unknown> | undefined {
  return toolDefsByName.get(tool) ?? (() => { try { const def = sharedCtx?.tools?.get?.(tool) as Record<string, unknown> | undefined; if (def) toolDefsByName.set(tool, def); return def; } catch { return undefined; } })();
}
function parseToolArgs(argsRaw: string | undefined): unknown {
  if (!argsRaw) return {};
  try { return JSON.parse(argsRaw); } catch { return {}; }
}
export function resolvePresentationMeta(tool: string, argsRaw: string | undefined, outputRaw: string | undefined): unknown {
  const def = toolDefByName(tool);
  const hook = (def?.output as { presentationMeta?: (a: unknown, v: unknown) => unknown } | undefined)?.presentationMeta;
  if (typeof hook !== "function") return undefined;
  const args: unknown = parseToolArgs(argsRaw);
  let value: unknown; if (outputRaw) { try { value = JSON.parse(outputRaw); } catch { value = outputRaw; } }
  try { return hook(args, value) ?? undefined; } catch { return undefined; }
}

/** dsh tool-authored call view (`ToolDefinition.presentCall`) — title/card for chips. */
export interface ToolCallViewLike {
  card?: unknown;
  title?: unknown;
  [key: string]: unknown;
}

/**
 * Resolve a tool's self-described call view for chip labels. dsh tools set
 * `presentCall` (bash → terminal card titled with the command, jobs →
 * "Read output from background job X", todo → "Update todo list"); Cairn's
 * own tools don't, so those fall back to `humanize-tool.ts` in the renderer.
 * Version bumps improve dsh labels for free — no per-tool UI mapping.
 */
export function resolveToolCallView(tool: string, argsRaw: string | undefined): ToolCallViewLike | undefined {
  const def = toolDefByName(tool);
  const present = (def as { presentCall?: (args: unknown) => unknown } | undefined)?.presentCall;
  if (typeof present !== "function") return undefined;
  try {
    const view = present(parseToolArgs(argsRaw)) as ToolCallViewLike | undefined;
    if (!view || typeof view !== "object" || typeof view.title !== "string" || !view.title) return undefined;
    return view;
  } catch { return undefined; }
}

/**
 * Attach the tool-authored call view to a live `tool/call` session event for
 * the renderer (shallow-copies data; the persisted log event is untouched).
 * Non-tool/call events pass through unchanged.
 */
export function withToolCallView<T extends { type?: unknown; data?: unknown }>(event: T): T {
  if (!event || (event as { type?: unknown }).type !== "tool/call") return event;
  const data = (event as { data?: Record<string, unknown> }).data;
  if (!data || typeof data !== "object" || (data as { view?: unknown }).view !== undefined) return event;
  const name = typeof data.name === "string" ? data.name : "tool";
  const argsRaw = typeof data.arguments === "string" ? data.arguments : undefined;
  if (typeof data.callId === "string") noteToolCall(data.callId, name, argsRaw);
  const view = resolveToolCallView(name, argsRaw);
  if (!view) return event;
  return { ...event, data: { ...data, view } };
}

/** dsh tool-authored result view (`ToolDefinition.presentResult`) — title/card for done chips. */
export interface ToolResultViewLike {
  card?: unknown;
  title?: unknown;
  [key: string]: unknown;
}

/**
 * Resolve a tool's self-described result view. dsh calls
 * `presentResult(args, result: ToolResult)`; hosts only have the rendered
 * output text, so this synthesizes the `{content, isError}` shape presenters
 * read (bash's only inspects the single text block + isError). At rc.1 only
 * bash/pwsh define `presentResult` (terminal/exit-pill cards); fs/search/read
 * tools will flow through unmodified when upstream adds theirs.
 */
export function resolveToolResultView(
  tool: string,
  argsRaw: string | undefined,
  outputText: string | undefined,
  isError?: boolean,
): ToolResultViewLike | undefined {
  const def = toolDefByName(tool);
  const present = (def as { presentResult?: (args: unknown, result: unknown) => unknown } | undefined)?.presentResult;
  if (typeof present !== "function") return undefined;
  try {
    const view = present(parseToolArgs(argsRaw), {
      content: [{ type: "text", text: outputText ?? "" }],
      isError: isError === true,
    }) as ToolResultViewLike | undefined;
    if (!view || typeof view !== "object" || typeof view.card !== "string") return undefined;
    return view;
  } catch { return undefined; }
}

// Pending-call registry bridging tool/call → tool/result at broadcast time:
// the result event carries only a callId, so the call site stashes name + args
// for the result attach. Bounded (stale ids from never-settling calls prune on
// overflow); keyed per process, and callIds are unique per session.
const pendingToolCalls = new Map<string, { tool: string; argsRaw?: string }>();
function noteToolCall(callId: string, tool: string, argsRaw?: string): void {
  if (pendingToolCalls.size > 500) pendingToolCalls.clear();
  pendingToolCalls.set(callId, { tool, argsRaw });
}

/**
 * Attach the tool-authored result view to a live `tool/result` event (see
 * `resolveToolResultView`). Resolves the tool name via the tool/call stash;
 * unknown callIds and view-less tools pass through unchanged.
 */
export function withToolResultView<T extends { type?: unknown; data?: unknown }>(event: T): T {
  if (!event || (event as { type?: unknown }).type !== "tool/result") return event;
  const data = (event as { data?: Record<string, unknown> }).data;
  if (!data || typeof data !== "object" || (data as { resultView?: unknown }).resultView !== undefined) return event;
  const message = data.message as { source?: { callId?: unknown }; content?: Array<{ isError?: unknown; content?: Array<{ type?: string; text?: string }> }> } | undefined;
  const callId =
    (typeof data.callId === "string" ? data.callId : undefined) ??
    (typeof message?.source?.callId === "string" ? message.source.callId : undefined);
  if (!callId) return event;
  const pending = pendingToolCalls.get(callId);
  pendingToolCalls.delete(callId);
  if (!pending) return event;
  const block = message?.content?.[0];
  const output = block?.content?.filter((b) => b?.type === "text" && b.text).map((b) => b.text).join("");
  const view = resolveToolResultView(pending.tool, pending.argsRaw, output, block?.isError === true);
  if (!view) return event;
  return { ...event, data: { ...data, resultView: view } };
}
