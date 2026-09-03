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
import JsonlSessionPersistence from "@deepseek-ai/dsh-session-persistence-jsonl";
import SessionQuerySqlite from "@deepseek-ai/dsh-session-query-sqlite";
import approvalService from "@deepseek-ai/dsh-user-approval";
import TokenMeter from "@deepseek-ai/dsh-token-meter";
import ToolResultPruner from "@deepseek-ai/dsh-compaction-tool-result-pruner";
import BasicCompactionEngine from "@deepseek-ai/dsh-compaction-basic";
import SkillRegistry from "@deepseek-ai/dsh-skill";
import InvariantRegistry from "@deepseek-ai/dsh-invariants";
import CommandRuntime from "@deepseek-ai/dsh-commands";
import planModePlugin from "@deepseek-ai/dsh-plan-mode";
import { apply as toolSkillApply, inject as toolSkillInject, name as toolSkillName } from "@deepseek-ai/dsh-tool-skill";
import { apply as llmRetryApply, inject as llmRetryInject, name as llmRetryName } from "@deepseek-ai/dsh-llm-retry";
import { apply as commandCompactApply, inject as commandCompactInject, name as commandCompactName } from "@deepseek-ai/dsh-command-compact";
import SessionTitleService from "@deepseek-ai/dsh-session-title";
import PermissionPresetService from "@deepseek-ai/dsh-permission-presets";
import { apply as firstPromptApply, inject as firstPromptInject, name as firstPromptName } from "@deepseek-ai/dsh-session-title-first-prompt-llm";
import { CairnAttachmentStore } from "./cairn-attachment-store";
import { LocalSpillStore } from "@deepseek-ai/dsh-spill-local";
import * as SpillPolicy from "@deepseek-ai/dsh-spill-policy";
import { app as electronApp } from "electron";
import path from "path";
import { createCairnSkillProvider } from "./cairn-skill-provider";
import { peekChatAgentCache } from "./chat-agent-cache";
import { SessionId } from "@deepseek-ai/dsh-session";

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
            const { getCachedConfig } = await import("../lib/config-cache");
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
    // Permission presets (workspace-write, danger-full-access + /permission).
    // Mounted post-bootstrap, NOT an ENTRY_LIST entry: it injects `shell`,
    // which is only mounted per-turn by the coding stack — as a loader entry
    // it would stall `loader.await()` forever at bootstrap. Static import so a
    // missing/broken package fails loudly at bundle time instead of degrading
    // to a "permission presets unavailable" warning at runtime.
    try { (ctx.plugin as (p: unknown, c?: unknown) => unknown)(PermissionPresetService, {}); } catch (err) { console.warn("[cordis] permission presets unavailable:", err instanceof Error ? err.message : err); }
    try { const { mountContextRing } = await import("./plugins/context-ring"); mountContextRing(ctx); } catch (err) { console.warn("[cordis] context ring unavailable:", err instanceof Error ? err.message : err); }
    try { const { mountWorkspaceContext } = await import("./plugins/workspace-context"); mountWorkspaceContext(ctx); } catch (err) { console.warn("[cordis] workspace context unavailable:", err instanceof Error ? err.message : err); }
    try { const { mountSessionTitleBridge } = await import("./plugins/session-title"); mountSessionTitleBridge(ctx); } catch (err) { console.warn("[cordis] session-title bridge unavailable:", err instanceof Error ? err.message : err); }
    try { const { mountPruneGuard } = await import("./prune-hook"); mountPruneGuard(ctx); } catch (err) { console.warn("[cordis] prune guard unavailable:", err instanceof Error ? err.message : err); }
    try { const { mountSessionDurability } = await import("./plugins/session-durability"); mountSessionDurability(ctx); } catch (err) { console.warn("[cordis] session durability unavailable:", err instanceof Error ? err.message : err); }
    try { const { loadUserPlugins, watchUserPlugins } = await import("./plugin-loader"); await loadUserPlugins(ctx); watchUserPlugins(ctx); } catch (err) { console.error("[cairn-plugins] runtime plugin layer failed to init:", err instanceof Error ? err.message : err); }
    // Background-job UI bridge: ctx.jobs change/completion → session:projection
    // kind:"jobs" for the renderer dock. Singleton-subscribed (idempotent).
    try { const { mountJobsBridge } = await import("./jobs-bridge"); mountJobsBridge(ctx); } catch (err) { console.warn("[cordis] jobs bridge unavailable:", err instanceof Error ? err.message : err); }
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
  const view = resolveToolCallView(
    typeof data.name === "string" ? data.name : "tool",
    typeof data.arguments === "string" ? data.arguments : undefined,
  );
  if (!view) return event;
  return { ...event, data: { ...data, view } };
}
