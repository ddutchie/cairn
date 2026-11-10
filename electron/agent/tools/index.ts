/**
 * Which tools each surface gets. Mirrors the old per-surface inventory:
 * chat = Cairn data (+ external); coding adds the filesystem/exec stack;
 * automation-dev gets files only.
 *
 * The order is part of the contract: built-ins first in a fixed order, connector tools last.
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
  onTodos?: (todos: TodoItem[], sessionId: string) => void;
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

/** The surface's tools in the order they are sent. The order is fixed: it is the front of the cached request prefix. */
export async function buildToolset(d: ToolsetDeps): Promise<AgentTool[]> {
  const tools: AgentTool[] = [];
  const add = (...more: AgentTool[]) => { tools.push(...more); };
  if (d.cairn) add(...cairnTools(d.cairn, { exclude: d.cairn.exclude }));
  if (d.surface !== "chat" && d.fs) {
    add(...fsTools(d.fs));
    if (d.surface === "coding") {
      add(bashTool(d.fs), webFetchTool(), todoTool(d.onTodos));
      const skill = skillTool({ cwd: d.fs.cwd });
      if (skill) add(skill);
    }
  }
  if (d.sessions && d.surface !== "automation-dev") add(...sessionTools(d.sessions));
  if (d.subagents && d.surface !== "automation-dev") add(...subagentTools(d.subagents));
  if (d.subagents && d.surface === "coding") add(...workflowTools(d.subagents));
  if (d.surface === "coding") {
    if (d.goal) add(...goalTools(d.goal));
    if (d.schedule) add(...scheduleTools(d.schedule));
    if (d.jobs) add(...jobTools(d.jobs));
    if (d.terminals) add(...terminalTools(d.terminals));
    const lsp = d.lsp && lspTool(d.lsp);
    if (lsp) add(lsp);
  }
  if (d.plan && d.surface === "coding") add(...planTools(d.plan));
  // Connector tools go last, in name order. Providers cache a request by its prefix and the tool
  // list is at the front of it, so a server that connects late or drops out must not shift the
  // built-in tools: with these at the end, only the connector tools themselves are re-read.
  if (d.external) {
    const external = await externalTools(d.external).catch((err) => { console.error("[agent] external tools unavailable:", err); return []; });
    const extras = await externalExtras(d.external).catch((err) => { console.error("[agent] MCP extras unavailable:", err); return undefined; });
    if (extras?.instructions) d.onInstructions?.(extras.instructions);
    add(...(extras?.tools ?? []), ...[...external].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)));
  }
  // First definition wins, so a connector can't replace a built-in tool.
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
