/**
 * Command hooks in the Claude Code / Codex config shape. Opt-in: a hooks.json
 * under ~/.config/cairn/hooks/ (`claude-code.json`, `codex.json`) is read, and
 * its UserPromptSubmit, PreToolUse, PostToolUse and Stop hooks run around the
 * loop. Each hook gets the event as JSON on stdin; exit code 2 (stderr is the
 * reason) or a JSON `decision: "block"` blocks, `permissionDecision` deny/ask
 * decides a tool call, and `additionalContext` is passed to the model.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface TurnHooks {
  /** Run before a prompt reaches the model. */
  userPrompt?(prompt: string): Promise<{ block?: string; context?: string }>;
  /** Run after policy and before a tool executes. */
  preTool?(call: { name: string; args: Record<string, unknown>; callId: string }): Promise<{ decision?: "deny" | "ask"; reason?: string }>;
  postTool?(call: { name: string; args: Record<string, unknown>; callId: string }, out: { text: string; isError: boolean }): Promise<{ block?: string; context?: string }>;
  /** Run when the model has finished; a reason makes it continue. */
  stop?(): Promise<{ continueWith?: string }>;
}

type EventName = "UserPromptSubmit" | "PreToolUse" | "PostToolUse" | "Stop";
interface HookCommand { command: string; timeoutMs: number }
interface HookGroup { matcher?: RegExp; hooks: HookCommand[] }
export type HookConfig = Partial<Record<EventName, HookGroup[]>>;

const DEFAULT_TIMEOUT_MS = 600_000;
const EVENTS: readonly EventName[] = ["UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"];

export function hookConfigPaths(home = os.homedir()): string[] {
  return ["claude-code.json", "codex.json"].map((f) => path.join(home, ".config", "cairn", "hooks", f)).filter((p) => existsSync(p));
}

/** Parse a hooks.json, or a settings file whose `hooks` key holds the config. Bad input yields no hooks. */
export function parseHookConfig(raw: string, projectDir: string): HookConfig {
  let doc: unknown;
  try { doc = JSON.parse(raw); } catch { return {}; }
  const hooks = (doc as { hooks?: Record<string, unknown> } | null)?.hooks ?? doc;
  const out: HookConfig = {};
  if (!hooks || typeof hooks !== "object") return out;
  for (const event of EVENTS) {
    const groups = (hooks as Record<string, unknown>)[event];
    if (!Array.isArray(groups)) continue;
    for (const g of groups as Array<{ matcher?: string; hooks?: Array<{ type?: string; command?: string; timeout?: number }> }>) {
      let matcher: RegExp | undefined;
      if (g.matcher && g.matcher !== "*") {
        try { matcher = new RegExp(`^(?:${g.matcher})$`); } catch { continue; } // an invalid matcher registers nothing
      }
      const commands = (g.hooks ?? [])
        .filter((h) => (h.type ?? "command") === "command" && typeof h.command === "string" && h.command)
        .map((h) => ({ command: h.command!.split("${CLAUDE_PROJECT_DIR}").join(projectDir), timeoutMs: typeof h.timeout === "number" ? h.timeout * 1000 : DEFAULT_TIMEOUT_MS }));
      if (commands.length) (out[event] ??= []).push({ matcher, hooks: commands });
    }
  }
  return out;
}

interface HookResult { code: number | null; stdout: string; stderr: string }

function runCommand(h: HookCommand, payload: unknown, cwd: string, signal?: AbortSignal): Promise<HookResult> {
  return new Promise((resolve) => {
    const shell = process.platform === "win32" ? { file: "powershell.exe", args: ["-NoProfile", "-Command", h.command] } : { file: "/bin/sh", args: ["-c", h.command] };
    const child = spawn(shell.file, shell.args, { cwd, env: { ...process.env, CLAUDE_PROJECT_DIR: cwd }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    const finish = (code: number | null) => { clearTimeout(timer); signal?.removeEventListener("abort", kill); resolve({ code, stdout, stderr }); };
    const kill = () => child.kill("SIGKILL");
    const timer = setTimeout(kill, h.timeoutMs);
    signal?.addEventListener("abort", kill, { once: true });
    child.on("error", (err) => { stderr += err.message; finish(1); });
    child.on("close", finish);
    child.stdin.on("error", () => undefined);
    child.stdin.end(JSON.stringify(payload));
  });
}

interface Parsed { block?: string; permission?: "deny" | "ask" | "allow"; permissionReason?: string; context?: string }

function interpret(r: HookResult): Parsed {
  if (r.code === 2) return { block: r.stderr.trim() || "blocked by hook" };
  if (r.code !== 0) return {};
  let json: Record<string, unknown> | undefined;
  try { json = r.stdout.trim().startsWith("{") ? JSON.parse(r.stdout) : undefined; } catch { json = undefined; }
  if (!json) return {};
  const specific = (json.hookSpecificOutput ?? {}) as Record<string, unknown>;
  const reason = typeof json.reason === "string" ? json.reason : typeof specific.permissionDecisionReason === "string" ? specific.permissionDecisionReason : undefined;
  const context = typeof specific.additionalContext === "string" ? specific.additionalContext : typeof json.additionalContext === "string" ? json.additionalContext : undefined;
  const permission = specific.permissionDecision === "deny" || specific.permissionDecision === "ask" || specific.permissionDecision === "allow" ? specific.permissionDecision : undefined;
  return { block: json.decision === "block" ? reason ?? "blocked by hook" : undefined, permission, permissionReason: reason, context };
}

/** Hooks for one session, or undefined when none are configured. */
export function createHooks(opts: { sessionId: string; cwd: string; configs?: HookConfig[]; paths?: string[] }): TurnHooks | undefined {
  const configs = opts.configs ?? (opts.paths ?? hookConfigPaths()).map((p) => {
    try { return parseHookConfig(readFileSync(p, "utf8"), opts.cwd); } catch { return {}; }
  });
  if (!configs.some((c) => Object.keys(c).length)) return undefined;
  const base = { session_id: opts.sessionId, transcript_path: "", cwd: opts.cwd };

  async function run(event: EventName, subject: string | undefined, extra: Record<string, unknown>, signal?: AbortSignal): Promise<Parsed[]> {
    const results: Parsed[] = [];
    for (const config of configs) {
      for (const group of config[event] ?? []) {
        if (group.matcher && !(subject !== undefined && group.matcher.test(subject))) continue;
        for (const h of group.hooks) {
          try { results.push(interpret(await runCommand(h, { ...base, hook_event_name: event, ...extra }, opts.cwd, signal))); }
          catch (err) { console.warn(`[hooks] ${event} hook failed:`, err instanceof Error ? err.message : err); }
        }
      }
    }
    return results;
  }
  const contexts = (rs: Parsed[]) => rs.map((r) => r.context).filter(Boolean).join("\n") || undefined;

  return {
    async userPrompt(prompt) {
      const rs = await run("UserPromptSubmit", undefined, { prompt });
      const blocked = rs.find((r) => r.block);
      return blocked ? { block: blocked.block } : { context: contexts(rs) };
    },
    async preTool(call) {
      const rs = await run("PreToolUse", call.name, { tool_name: call.name, tool_input: call.args, tool_use_id: call.callId });
      const deny = rs.find((r) => r.block || r.permission === "deny");
      if (deny) return { decision: "deny", reason: deny.block ?? deny.permissionReason };
      const ask = rs.find((r) => r.permission === "ask");
      return ask ? { decision: "ask", reason: ask.permissionReason } : {};
    },
    async postTool(call, out) {
      const rs = await run("PostToolUse", call.name, { tool_name: call.name, tool_input: call.args, tool_response: out.text, tool_use_id: call.callId });
      const blocked = rs.find((r) => r.block);
      return blocked ? { block: blocked.block } : { context: contexts(rs) };
    },
    async stop() {
      const rs = await run("Stop", undefined, { stop_hook_active: false });
      const blocked = rs.find((r) => r.block);
      return blocked ? { continueWith: blocked.block } : {};
    },
  };
}
