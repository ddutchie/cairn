/**
 * Cairn — per-surface tool inventory (single source of truth for Settings UI).
 *
 * The model sees a different toolset per surface. The chat / coding /
 * automation-dev lists are what the engine's `buildToolset` actually registers
 * (built with inert dependencies: nothing here ever executes a tool); the MCP
 * list is the Cairn data tools minus the chat-only ones. Workspace MCP servers
 * and plugin tools are per-workspace and not part of this static view.
 */

import { Type } from "@earendil-works/pi-ai";
import { TOOL_SCHEMAS, CHAT_ONLY_TOOLS, CHAT_EXCLUDED_TOOLS, toolCategory } from "./tool-schemas";
import { buildToolset, type ToolSurface, type ToolsetDeps } from "../agent/tools/index";
import type { AgentTool } from "../agent/tools";
import type { InventoryCategory, InventorySource, InventorySurface, InventoryTool } from "../../shared/types/runtime";
export type { InventoryCategory, InventorySource, InventorySurface, InventoryTool };

/** Chat registers `delete` but asks before every use. */
export const CHAT_GATED_TOOLS: ReadonlySet<string> = new Set(["delete"]);

const READ_TOOLS = new Set(["read", "read_image", "glob", "grep", "lsp", "terminal_read", "terminal_list", "list_agents", "job_output", "job_list", "web_fetch", "skill"]);
const WRITE_TOOLS = new Set(["write", "edit", "str_replace_editor", "todo_write", "goal_create", "goal_update", "schedule_add", "schedule_cancel"]);
/** Registered on top of the filesystem/exec stack by the engine rather than the Cairn data layer. */
const GLOBAL_TOOLS = new Set(["subagent", "delegate", "send_message", "list_agents", "interrupt_agent", "skill", "web_fetch", "workflow", "ralph", "exit_plan_mode"]);

function categoryOf(name: string): InventoryCategory {
  if (name in TOOL_SCHEMAS) return toolCategory(name);
  if (READ_TOOLS.has(name)) return "read";
  if (WRITE_TOOLS.has(name)) return "write";
  return "exec";
}

function describe(tool: AgentTool, gate?: ReadonlySet<string>): InventoryTool {
  return {
    name: tool.name,
    description: tool.description,
    category: categoryOf(tool.name),
    source: tool.name in TOOL_SCHEMAS ? "cairn" : GLOBAL_TOOLS.has(tool.name) ? "global" : "coding",
    ...(gate?.has(tool.name) ? { gated: true } : {}),
  };
}

/** Dependencies that let every tool construct; none is ever called. */
function inertDeps(surface: ToolSurface): ToolsetDeps {
  const unused = (): never => { throw new Error("inventory only"); };
  const stub = <T>(): T => new Proxy({}, { get: () => unused }) as T;
  const subagents = stub<NonNullable<ToolsetDeps["subagents"]>>();
  return {
    surface,
    cairn: surface === "automation-dev" ? undefined : {
      exclude: surface === "chat" ? new Set<string>(CHAT_EXCLUDED_TOOLS) : undefined,
      getDb: unused, req: { message: "", threadId: "inventory" } as never, workspacePath: "", llmConfig: {} as never,
    },
    fs: { cwd: process.cwd(), rgPath: "rg" },
    subagents: surface === "automation-dev" ? undefined : subagents,
    goal: stub(), schedule: stub(), jobs: stub(),
    terminals: surface === "coding" ? stub() : undefined,
    lsp: surface === "coding" ? { manager: { available: true } as never, cwd: process.cwd() } : undefined,
  };
}

/**
 * What each surface registers. `exit_plan_mode` (plan mode only) and `workflow`/`ralph`
 * are listed because they appear on coding turns.
 */
export async function buildInventory(): Promise<Record<InventorySurface, InventoryTool[]>> {
  const forSurface = async (surface: ToolSurface, gate?: ReadonlySet<string>) =>
    (await buildToolset(inertDeps(surface))).map((t) => describe(t, gate)).sort((a, b) => a.name.localeCompare(b.name));
  const mcp: InventoryTool[] = Object.entries(TOOL_SCHEMAS)
    .filter(([name]) => !(CHAT_ONLY_TOOLS as readonly string[]).includes(name))
    .map(([name, { description }]) => ({ name, description, category: toolCategory(name), source: "cairn" as const }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return {
    chat: await forSurface("chat", CHAT_GATED_TOOLS),
    coding: await forSurface("coding"),
    "automation-dev": await forSurface("automation-dev"),
    mcp,
  };
}

/** Counts per surface, for tab badges. */
export function inventoryCounts(inv: Record<InventorySurface, InventoryTool[]>): Record<InventorySurface, number> {
  return {
    chat: inv.chat.length,
    coding: inv.coding.length,
    "automation-dev": inv["automation-dev"].length,
    mcp: inv.mcp.length,
  };
}
void Type;
