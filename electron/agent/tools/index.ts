/**
 * Which tools each surface gets. Mirrors the old per-surface inventory:
 * chat = Cairn data (+ external); coding adds the filesystem/exec stack;
 * automation-dev gets files only.
 */
import type { AgentTool } from "../tools";
import { bashTool, type BashDeps } from "./bash";
import { cairnTools, type CairnToolDeps } from "./cairn";
import { externalExtras, externalTools, type ExternalToolDeps } from "./external";
import { goalTools, type GoalDeps } from "./goal";
import { jobTools, type JobToolDeps } from "./jobs";
import { scheduleTools, type ScheduleDeps } from "./schedule";
import { fsTools, type FsDeps } from "./fs";
import { lspTool, type LspDeps } from "./lsp";
import { planTools, type PlanDeps } from "./plan";
import { subagentTools, type SubagentDeps } from "./subagent";
import { sessionTools, type SessionToolDeps } from "./sessions";
import { skillTool } from "./skill";
import { workflowTools } from "./workflow";
import { terminalTools, type TerminalDeps } from "./terminal";
import { todoTool, type TodoItem } from "./todo";
import { webFetchTool } from "./web";

export type ToolSurface = "chat" | "coding" | "automation-dev";

export interface ToolsetDeps {
  surface: ToolSurface;
  cairn?: CairnToolDeps;
  external?: ExternalToolDeps;
  /** Receives MCP server instructions, for the system prompt. */
  onInstructions?: (text: string) => void;
  fs?: FsDeps & BashDeps;
  onTodos?: (todos: TodoItem[]) => void;
  /** Coding sessions in plan mode: how the model hands over its plan. */
  plan?: PlanDeps;
  /** Offered on coding and chat; children never get it. */
  subagents?: SubagentDeps;
  /** Coding sessions: a standing goal, reminders and background jobs. */
  goal?: GoalDeps;
  schedule?: ScheduleDeps;
  jobs?: JobToolDeps;
  terminals?: TerminalDeps;
  /** Search of earlier chats and coding sessions; offered on chat and coding. */
  sessions?: SessionToolDeps;
  lsp?: LspDeps;
}

export async function buildToolset(d: ToolsetDeps): Promise<AgentTool[]> {
  const tools: AgentTool[] = [];
  if (d.cairn) tools.push(...cairnTools(d.cairn, { exclude: d.cairn.exclude }));
  if (d.external) tools.push(...await externalTools(d.external).catch((err) => { console.error("[agent] external tools unavailable:", err); return []; }));
  if (d.external) {
    const extras = await externalExtras(d.external).catch((err) => { console.error("[agent] MCP extras unavailable:", err); return undefined; });
    if (extras) { tools.push(...extras.tools); if (extras.instructions) d.onInstructions?.(extras.instructions); }
  }
  if (d.surface !== "chat" && d.fs) {
    tools.push(...fsTools(d.fs));
    if (d.surface === "coding") {
      tools.push(bashTool(d.fs), webFetchTool(), todoTool(d.onTodos));
      const skill = skillTool({ cwd: d.fs.cwd });
      if (skill) tools.push(skill);
    }
  }
  if (d.sessions && d.surface !== "automation-dev") tools.push(...sessionTools(d.sessions));
  if (d.subagents && d.surface !== "automation-dev") tools.push(...subagentTools(d.subagents));
  if (d.subagents && d.surface === "coding") tools.push(...workflowTools(d.subagents));
  if (d.surface === "coding") {
    if (d.goal) tools.push(...goalTools(d.goal));
    if (d.schedule) tools.push(...scheduleTools(d.schedule));
    if (d.jobs) tools.push(...jobTools(d.jobs));
    if (d.terminals) tools.push(...terminalTools(d.terminals));
    const lsp = d.lsp && lspTool(d.lsp);
    if (lsp) tools.push(lsp);
  }
  if (d.plan && d.surface === "coding") tools.push(...planTools(d.plan));
  const seen = new Set<string>();
  return tools.filter((t) => (seen.has(t.name) ? false : (seen.add(t.name), true)));
}

export * from "./bash";
export * from "./cairn";
export * from "./external";
export * from "./fs";
export * from "./goal";
export * from "./jobs";
export * from "./schedule";
export * from "./lsp";
export * from "./plan";
export * from "./skill";
export * from "./subagent";
export * from "./terminal";
export * from "./todo";
export * from "./workflow";
export * from "./web";
