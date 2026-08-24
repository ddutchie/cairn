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
import { LocalAttachmentStore } from "@deepseek-ai/dsh-attachment-local";
import { app as electronApp } from "electron";
import path from "path";
import { createCairnSkillProvider } from "./cairn-skill-provider";
import { peekChatAgentCache } from "./chat-agent-cache";
import { SessionId } from "@deepseek-ai/dsh-session";

let sharedCtx: Context | null = null;
let contextReady: Promise<Context> | null = null;
let sessionRoot = process.env.CAIRN_SESSION_ROOT || path.join(process.cwd(), ".cairn-sessions");

export function getSessionRoot(): string { return sessionRoot; }
export function setSessionRoot(root: string): void { sessionRoot = root; }

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
    B["dsh:agent-loop"] = agentLoopPlugin;
    B["dsh:token-meter"] = TokenMeter;
    B["dsh:compaction"] = BasicCompactionEngine;
    B["dsh:subagent"] = subagentServicePlugin;
    B["dsh:skills"] = SkillRegistry;
    B["dsh:invariants"] = InvariantRegistry;
    B["dsh:tool-skill"] = { apply: toolSkillApply, inject: toolSkillInject, name: toolSkillName };
    B["dsh:commands"] = CommandRuntime;
    B["dsh:plan-mode"] = planModePlugin;
    B["cairn:attachment-store"] = LocalAttachmentStore;
    B["cairn:llm-retry"] = { apply: llmRetryApply, inject: llmRetryInject, name: llmRetryName };
    B["cairn:subagent-spawn"] = { apply: spawnProviderApply, inject: spawnProviderInject, name: spawnProviderName };
    B["cairn:tool-subagent"] = { apply: toolSubagentApply, inject: toolSubagentInject, name: toolSubagentName };
    const entries: Array<Record<string, unknown>> = [
      { id: "session", name: "cordis:dsh:session" },
      { id: "llm", name: "cordis:dsh:llm" },
      { id: "system-prompt", name: "cordis:dsh:system-prompt", config: { persona: "", includeHarnessIdentity: false } },
      { id: "agent", name: "cordis:dsh:agent" },
      { id: "tools", name: "cordis:dsh:tools", config: { mode: "native" } },
      { id: "user-questions", name: "cordis:dsh:user-questions" },
      { id: "approval", name: "cordis:dsh:approval", config: { policy: "ask" } },
      { id: "session-persistence", name: "cordis:dsh:session-persistence", config: { root: sessionRoot } },
      { id: "agent-loop", name: "cordis:dsh:agent-loop", config: { agents: [] } },
      { id: "attachment-store", name: "cordis:cairn:attachment-store", config: { dshHome: path.join(process.env.CAIRN_USER_DATA_DIR || electronApp?.getPath?.("userData") || process.cwd(), "dsh") } },
      { id: "token-meter", name: "cordis:dsh:token-meter" },
      { id: "compaction", name: "cordis:dsh:compaction", config: { auto: true, thresholdRatio: 0.8 } },
      { id: "llm-retry", name: "cordis:cairn:llm-retry", config: {} },
      { id: "subagent", name: "cordis:dsh:subagent" },
      { id: "skills", name: "cordis:dsh:skills" },
      { id: "invariants", name: "cordis:dsh:invariants" },
      { id: "tool-skill", name: "cordis:dsh:tool-skill" },
      { id: "commands", name: "cordis:dsh:commands" },
      { id: "plan-mode", name: "cordis:dsh:plan-mode", config: { section: "You are in plan mode. Stay in plan mode until the user switches the session mode. Explore and read first; do not edit files or run mutating commands." } },
      { id: "subagent-spawn", name: "cordis:cairn:subagent-spawn", config: { providerName: "spawn" } },
      { id: "tool-subagent", name: "cordis:cairn:tool-subagent", config: { provider: "spawn", toolName: "subagent", backgroundMode: "one-shot" } },
    ];
    for (const entry of entries) await loader.create(entry);
    await loader.await();
    try { const { registerCairnCommands } = await import("./cairn-commands"); registerCairnCommands(ctx); } catch (err) { console.warn("[cordis] cairn command registration failed:", err instanceof Error ? err.message : err); }
    try { if (ctx.skills) ctx.skills.registerProvider(() => createCairnSkillProvider()); } catch (err) { console.error("[cordis] cairn skill provider registration failed:", err instanceof Error ? err.message : err); }
    try { const { defineTool } = await import("@deepseek-ai/dsh-tools"); ctx.cairn = { defineTool, confirm: async (sessionId, req, opts) => { const { getConfirmTransport } = await import("./approval-transports"); const transport = getConfirmTransport(sessionId); if (!transport) return "cancelled" as const; return transport.confirm({ ...req, signal: opts?.signal }); } }; } catch { /* best-effort */ }
    try { const { PermissionPresetService } = await import("@deepseek-ai/dsh-permission-presets"); (ctx.plugin as (p: unknown, c?: unknown) => unknown)(PermissionPresetService, {}); } catch (err) { console.warn("[cordis] permission presets unavailable:", err instanceof Error ? err.message : err); }
    try { const { default: ProjectionRegistry } = await import("@deepseek-ai/dsh-session-projection"); (ctx.plugin as (p: unknown, c?: unknown) => unknown)(ProjectionRegistry, {}); } catch (err) { console.warn("[cordis] session projections unavailable:", err instanceof Error ? err.message : err); }
    try { const { mountContextRing } = await import("./plugins/context-ring"); mountContextRing(ctx); } catch (err) { console.warn("[cordis] context ring unavailable:", err instanceof Error ? err.message : err); }
    try { const { mountWorkspaceContext } = await import("./plugins/workspace-context"); mountWorkspaceContext(ctx); } catch (err) { console.warn("[cordis] workspace context unavailable:", err instanceof Error ? err.message : err); }
    try { const { loadUserPlugins, watchUserPlugins } = await import("./plugin-loader"); await loadUserPlugins(ctx); watchUserPlugins(ctx); } catch (err) { console.error("[cairn-plugins] runtime plugin layer failed to init:", err instanceof Error ? err.message : err); }
    sharedCtx = ctx;
    return ctx;
  })();
  return contextReady;
}

export async function dropChatAgentForThread(threadId: string): Promise<void> {
  const map = peekChatAgentCache();
  if (map) {
    const entry = map.get(threadId);
    if (entry) {
      map.delete(threadId);
      const agent = (entry.agent ?? entry) as Record<PropertyKey, unknown>;
      try { const whenIdle = (entry.whenIdle ?? agent.whenIdle) as (() => Promise<void>) | undefined; if (typeof whenIdle === "function") await whenIdle.call(agent); } catch { /* best-effort */ }
      for (const obj of Array.from(new Set([entry.handle, entry.agent, entry].filter(Boolean))) as Array<Record<PropertyKey, unknown>>) {
        for (const key of [Symbol.asyncDispose, Symbol.dispose, "dispose", "close", "abort"] as const) {
          try { const fn = obj[key] as (() => unknown) | undefined; if (typeof fn === "function") { await fn.call(obj); break; } } catch { /* best-effort */ }
        }
      }
    }
  }
  try { const ctx = await getContext(); const session = ctx.sessions?.get?.(SessionId(`chat-${threadId}`)) as { [Symbol.dispose]?: () => void; dispose?: () => void } | undefined; session?.[Symbol.dispose]?.(); session?.dispose?.(); } catch { /* best-effort */ }
}

const toolDefsByName = new Map<string, Record<string, unknown>>();
export function __setToolDefForTest(name: string, def: Record<string, unknown> | undefined): void {
  if (def) toolDefsByName.set(name, def);
  else toolDefsByName.delete(name);
}
export function resolvePresentationMeta(tool: string, argsRaw: string | undefined, outputRaw: string | undefined): unknown {
  const def = toolDefsByName.get(tool) ?? (() => { try { const def = sharedCtx?.tools?.get?.(tool) as Record<string, unknown> | undefined; if (def) toolDefsByName.set(tool, def); return def; } catch { return undefined; } })();
  const hook = (def?.output as { presentationMeta?: (a: unknown, v: unknown) => unknown } | undefined)?.presentationMeta;
  if (typeof hook !== "function") return undefined;
  let args: unknown = {}; if (argsRaw) { try { args = JSON.parse(argsRaw); } catch { /* best-effort */ } }
  let value: unknown; if (outputRaw) { try { value = JSON.parse(outputRaw); } catch { value = outputRaw; } }
  try { return hook(args, value) ?? undefined; } catch { return undefined; }
}
