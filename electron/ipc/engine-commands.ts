/**
 * Slash commands and the system-prompt preview on the engine. The command
 * set mirrors what the old registry offered (/plan, /compact, /goal,
 * /permission, /export); each returns the `{kind, text}` the composer shows.
 */
import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import * as electron from "electron";
import os from "node:os";
import type { DbContext } from "./result-helpers";
import { compactEngineSession, getEngineHost, hostRoot, readEnginePermissions, setEnginePermission, PERMISSION_PRESETS } from "./engine-bridge";
import { getCodingSessionById, updateCodingSession } from "../db/sessions-queries";
import { getCachedConfig } from "../lib/config-cache";
import { normaliseBaseUrl } from "../lib/llm";
import { resolveLlmApiKey } from "../lib/secure-store";
import { buildAgentSystemPrompt } from "../lib/coding-session-prompt";
import { buildSystemPrompt } from "../lib/tools";
import { SESSION_FILE } from "../agent/session/log";
import type { CommandExecutionResult, SystemPromptPreview } from "../../shared/types/runtime";
import type { AgentLLMConfig } from "../lib/session-runtime-types";
import type { GoalState } from "../agent/events";
import { makeSessionProjection } from "../../shared/agent/session-projection";
import { broadcastEvent } from "./registry";

export const ENGINE_COMMANDS: ReadonlyArray<{ name: string; description: string }> = [
  { name: "plan", description: "Enter or leave plan mode" },
  { name: "compact", description: "Summarise earlier conversation to free up context" },
  { name: "goal", description: "Set, show, pause, resume, complete or clear the session goal" },
  { name: "permission", description: "Show or change the permission preset" },
  { name: "export", description: "Save this session's log to a file" },
];

const ok = (text: string, extra: Partial<CommandExecutionResult> = {}): CommandExecutionResult => ({ kind: "success", text, ...extra });
const err = (text: string): CommandExecutionResult => ({ kind: "error", text });

const describeGoal = (g: GoalState | null) =>
  g ? `Goal [${g.phase}] round ${g.roundsStarted}/${g.maxGoalRounds}: ${g.objective}${g.blockedReason ? ` (blocked: ${g.blockedReason})` : ""}` : "No goal is set.";

function exportsDir(): string {
  let base: string;
  try { base = electron.app.getPath("userData"); } catch { base = os.tmpdir(); }
  return path.join(process.env.CAIRN_USER_DATA_DIR || base, "session-exports");
}

/** Timeline chips: the renderer folds these like engine events, outside any turn. */
export function emitSessionChip(sessionId: string, type: string, data: Record<string, unknown>): void {
  broadcastEvent("session:event", { sessionId, event: { type, seq: -1, time: Date.now(), data } });
}

export async function executeEngineCommand(ctx: DbContext, req: { sessionId: string; line: string }): Promise<CommandExecutionResult> {
  const name = req.line.trim().replace(/^\/\s*/, "").split(/\s+/)[0] ?? "";
  const id = `cmd-${Date.now()}`;
  emitSessionChip(req.sessionId, "command/run", { name, line: req.line, id });
  const result = await runEngineCommand(ctx, req);
  emitSessionChip(req.sessionId, "command/done", { name, id, kind: result.kind, text: result.text });
  return result;
}

async function runEngineCommand(ctx: DbContext, req: { sessionId: string; line: string }): Promise<CommandExecutionResult> {
  const { sessionId } = req;
  const [head = "", ...rest] = req.line.trim().replace(/^\/\s*/, "").split(/\s+/);
  const arg = rest.join(" ").trim();
  const host = getEngineHost(ctx);

  switch (head) {
    case "plan": {
      if (sessionId.startsWith("chat-")) return err("Plan mode is only available in coding sessions.");
      const row = getCodingSessionById(ctx.db, sessionId);
      const current = (row as { mode?: string } | null)?.mode === "plan" ? "plan" : "execute";
      const mode = arg === "off" ? "execute" : arg === "" ? (current === "plan" ? "execute" : "plan") : "plan";
      try { updateCodingSession(ctx.db, sessionId, { mode, updatedAt: new Date().toISOString() }); } catch { /* the session may not be indexed yet */ }
      broadcastEvent("session:projection", makeSessionProjection(sessionId, "mode-change", { mode }));
      emitSessionChip(sessionId, "plan/mode", { active: mode === "plan" });
      return ok(mode === "plan" ? "Plan mode on." : "Plan mode off.", { mode });
    }
    case "compact": {
      const row = getCodingSessionById(ctx.db, sessionId) as { cwd?: string } | null;
      const cfg = getCachedConfig().agentConfig;
      const llmConfig: AgentLLMConfig = {
        baseUrl: normaliseBaseUrl(cfg?.baseUrl || "https://api.openai.com"), model: cfg?.model ?? "", apiKey: resolveLlmApiKey(cfg?.apiKey),
        maxSteps: 20, temperature: 0.1,
      };
      try {
        const outcome = await compactEngineSession(ctx, { sessionId, cwd: row?.cwd ?? ctx.workspacePath ?? "/", llmConfig });
        if (outcome === "busy") return err("Can't compact while the agent is working.");
        if (outcome === "nothing") broadcastEvent("session:projection", makeSessionProjection(sessionId, "compact", { status: "end" }));
        return ok(outcome === "compacted" ? "Compacted." : "Nothing to compact.");
      } catch (e) {
        return err(`Compaction unavailable: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    case "goal": {
      if (arg === "" || arg === "show") return ok(describeGoal(await host.readGoal(sessionId)));
      if (arg === "clear") { await host.clearGoal(sessionId); return ok("Goal cleared."); }
      const phase = ({ pause: "paused", resume: "active", complete: "complete" } as const)[arg as "pause" | "resume" | "complete"];
      if (phase) {
        const g = await host.updateGoal(sessionId, { phase });
        return g ? ok(describeGoal(g)) : err("No goal is set.");
      }
      const g = await host.createGoal(sessionId, arg);
      return ok(`${describeGoal(g)}\nSend a message to start working on it.`);
    }
    case "permission": {
      if (!arg) {
        const v = readEnginePermissions(sessionId, undefined);
        return ok(`Current: ${v.currentValue}. Presets: ${v.options.map((o) => o.value).join(", ")}.`);
      }
      if (!PERMISSION_PRESETS.some((p) => p.value === arg)) return err(`Unknown preset "${arg}". Presets: ${PERMISSION_PRESETS.map((p) => p.value).join(", ")}.`);
      setEnginePermission(sessionId, arg, undefined);
      return ok(`Permission preset: ${arg}.`);
    }
    case "export": {
      const dir = exportsDir();
      await mkdir(dir, { recursive: true });
      const dest = path.join(dir, `${sessionId}-${Date.now()}.jsonl`);
      try { await copyFile(path.join(hostRoot(), sessionId, SESSION_FILE), dest); } catch { return err("This session has no log to export yet."); }
      return ok(`Session log saved to ${dest}`);
    }
    default:
      return err(`Unknown command: /${head}`);
  }
}

/** What the engine sends as the system prompt for a coding turn, with the tools it offers. */
export async function previewEnginePrompt(ctx: DbContext, cwd: string): Promise<SystemPromptPreview> {
  try {
    const text = buildAgentSystemPrompt({ projectName: "Project", cwd: cwd || ctx.workspacePath || process.cwd(), mode: "execute", role: "default" });
    const chat = buildSystemPrompt({ message: "", threadId: "preview", projectId: "", workspaceId: "" } as never);
    const { buildInventory } = await import("../lib/tool-inventory");
    const tools = (await buildInventory()).coding.map((t) => ({ name: t.name, description: t.description })).sort((a, b) => a.name.localeCompare(b.name));
    return {
      text,
      sections: [{ name: "coding", order: 0, text, index: 0 }, { name: "chat", order: 1, text: chat, index: 1 }],
      contexts: [], skills: [], tools, variables: {},
    };
  } catch (e) {
    return { text: "", sections: [], contexts: [], skills: [], tools: [], variables: {}, error: e instanceof Error ? e.message : String(e) };
  }
}
