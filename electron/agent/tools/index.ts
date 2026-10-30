/**
 * Which tools each surface gets. Mirrors the old per-surface inventory:
 * chat = Cairn data (+ external); coding adds the filesystem/exec stack;
 * automation-dev gets files only.
 */
import type { AgentTool } from "../tools";
import { bashTool, type BashDeps } from "./bash";
import { cairnTools, type CairnToolDeps } from "./cairn";
import { externalTools, type ExternalToolDeps } from "./external";
import { fsTools, type FsDeps } from "./fs";
import { todoTool, type TodoItem } from "./todo";
import { webFetchTool } from "./web";

export type ToolSurface = "chat" | "coding" | "automation-dev";

export interface ToolsetDeps {
  surface: ToolSurface;
  cairn?: CairnToolDeps;
  external?: ExternalToolDeps;
  fs?: FsDeps & BashDeps;
  onTodos?: (todos: TodoItem[]) => void;
}

export async function buildToolset(d: ToolsetDeps): Promise<AgentTool[]> {
  const tools: AgentTool[] = [];
  if (d.cairn) tools.push(...cairnTools(d.cairn, { exclude: d.cairn.exclude }));
  if (d.external) tools.push(...await externalTools(d.external).catch((err) => { console.error("[agent] external tools unavailable:", err); return []; }));
  if (d.surface !== "chat" && d.fs) {
    tools.push(...fsTools(d.fs));
    if (d.surface === "coding") tools.push(bashTool(d.fs), webFetchTool(), todoTool(d.onTodos));
  }
  const seen = new Set<string>();
  return tools.filter((t) => (seen.has(t.name) ? false : (seen.add(t.name), true)));
}

export * from "./bash";
export * from "./cairn";
export * from "./external";
export * from "./fs";
export * from "./todo";
export * from "./web";
