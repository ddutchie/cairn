/**
 * Cairn — per-surface tool inventory (single source of truth for Settings UI).
 *
 * Why this exists: the model sees a DIFFERENT toolset per surface, but the
 * renderer previously imported static lists (`MCP_TOOLS`) or read only the
 * global dsh view (which misses every per-turn registration). This module
 * computes what each surface actually registers, from the same sources the
 * loops use:
 *
 *   - Cairn data tools: `TOOL_SCHEMAS` (+ `CHAT_ONLY_TOOLS`,
 *     `AGENT_EXCLUDED_TOOLS` from `./tool-schemas`, and the chat-gated
 *     deletes from `../cordis/cairn-tools.ts` `CHAT_FORBIDDEN_TOOLS`).
 *   - Coding filesystem/exec tools: static manifest mirroring
 *     `mountCodingStack` in `../cordis/cordis-coding-tools.ts` (per-turn
 *     mounts — invisible to the global registry outside a turn, hence static).
 *   - Global dsh tools (subagent/delegate/jobs/skill/web_fetch/…): read LIVE
 *     from `ctx.tools` by the IPC handler and passed in as `globalTools`.
 *
 * No dsh imports here — pure + unit-testable. The IPC handler
 * (`runtime:tools:inventory`) merges the static computation with the live
 * global view.
 */

import { TOOL_SCHEMAS, CHAT_ONLY_TOOLS, AGENT_EXCLUDED_TOOLS } from "./tool-schemas";

export type InventoryCategory = "read" | "write" | "delete" | "exec";
export type InventorySource = "cairn" | "coding" | "global";

export interface InventoryTool {
  name: string;
  description: string;
  category: InventoryCategory;
  source: InventorySource;
  /** True when the tool registers but is approval-gated on that surface
   *  (chat's delete_note/delete_task/delete_project via askFilter). */
  gated?: boolean;
}

export type InventorySurface = "chat" | "coding" | "automation-dev" | "mcp";

/**
 * Mirror of `CHAT_FORBIDDEN_TOOLS` in `../cordis/cairn-tools.ts`.
 * Kept local so this module stays dsh-free; a test pins the two in sync.
 */
export const CHAT_GATED_TOOLS: ReadonlySet<string> = new Set([
  "delete_note",
  "delete_task",
  "delete_project",
]);

/**
 * Global tools hidden from the chat agent scope. Mirrors the `denyTools`
 * passed to `openCordisSessionAgent` in `../cordis/chat-session-runner.ts` —
 * chat's focus is the Cairn workspace, so it neither resolves the `skill`
 * tool nor receives the per-step `<available_skills>` catalog injection.
 */
export const CHAT_DENIED_GLOBAL_TOOLS: readonly string[] = ["skill"];

function cairnCategory(name: string): InventoryCategory {
  if (name.startsWith("delete_")) return "delete";
  if (name.startsWith("get_") || name.startsWith("list_") || name.startsWith("search_")) return "read";
  return "write";
}

export interface CodingStackTool {
  name: string;
  description: string;
  category: InventoryCategory;
}

/**
 * Static manifest of the model tools `mountCodingStack` registers per CODING
 * turn (`electron/cordis/cordis-coding-tools.ts`). Tool NAMES verified
 * against the dsh packages (tool-fs, tool-fs-search, tool-str-replace-editor,
 * tool-bash, tool-terminal, tool-todo, tool-workflow, tool-ralph).
 * Descriptions are short Cairn-side summaries (dsh owns the full schemas).
 *
 * `automation-dev` mounts the FS subset only (no bash/subprocess/terminal —
 * see the `role !== "automation-dev"` guard in `mountCodingStack`).
 */
export const CODING_FS_TOOLS: readonly CodingStackTool[] = [
  { name: "read", description: "Read file content (scoped to the session cwd).", category: "read" },
  { name: "write", description: "Create or overwrite a file.", category: "write" },
  { name: "edit", description: "Targeted edits to an existing file.", category: "write" },
  { name: "read_image", description: "Read an image file for vision context.", category: "read" },
  { name: "glob", description: "Find files by glob pattern.", category: "read" },
  { name: "grep", description: "Search file contents with ripgrep.", category: "read" },
  { name: "str_replace_editor", description: "Structured file editing (str-replace commands).", category: "write" },
  { name: "todo_write", description: "Maintain the session todo list (surfaced as session todos).", category: "write" },
  { name: "lsp", description: "Read-only code navigation (definition/references/hover). Needs a language server on PATH.", category: "read" },
];

export const CODING_EXEC_TOOLS: readonly CodingStackTool[] = [
  { name: "bash", description: "Run a shell command (sandboxed to workspace-write by default).", category: "exec" },
  { name: "terminal_open", description: "Open a persistent model shell (shared PTY manager).", category: "exec" },
  { name: "terminal_send", description: "Send input to a model shell.", category: "exec" },
  { name: "terminal_read", description: "Read output from a model shell.", category: "exec" },
  { name: "terminal_signal", description: "Send a signal to a model shell.", category: "exec" },
  { name: "terminal_close", description: "Close a model shell.", category: "exec" },
  { name: "terminal_list", description: "List model shells.", category: "exec" },
];

/**
 * Orchestration tools mounted on EVERY coding turn regardless of persona
 * (no role gate in `mountCodingStack`): fan out `spawn`-provider children
 * that inherit the turn's tool stack.
 */
export const CODING_ORCHESTRATION_TOOLS: readonly CodingStackTool[] = [
  { name: "workflow", description: "Run a JS orchestration fanning out subagents.", category: "exec" },
  { name: "ralph", description: "Run a bounded Ralph loop over subagents.", category: "exec" },
];

/** Full coding-turn stack (default persona). */
export const CODING_ALL_TOOLS: readonly CodingStackTool[] = [
  ...CODING_FS_TOOLS,
  ...CODING_EXEC_TOOLS,
  ...CODING_ORCHESTRATION_TOOLS,
];

/**
 * `automation-dev` persona: file tools + orchestration only. The role gate in
 * `mountCodingStack` skips bash/subprocess/terminal; todo/fs/search/workflow
 * still mount. No Cairn data tools either (see `cairnToolsExclude` in
 * `run-cordis-coding.ts`).
 */
export const AUTOMATION_DEV_TOOLS: readonly CodingStackTool[] = [
  ...CODING_FS_TOOLS,
  ...CODING_ORCHESTRATION_TOOLS,
];

function cairnTools(opts: { exclude?: ReadonlySet<string>; gate?: ReadonlySet<string> }): InventoryTool[] {
  const out: InventoryTool[] = [];
  for (const [name, { description }] of Object.entries(TOOL_SCHEMAS)) {
    if (opts.exclude?.has(name)) continue;
    out.push({
      name,
      description,
      category: cairnCategory(name),
      source: "cairn",
      ...(opts.gate?.has(name) ? { gated: true } : {}),
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

function codingTools(list: readonly CodingStackTool[]): InventoryTool[] {
  return list.map((t) => ({ ...t, source: "coding" as const }));
}

/**
 * Compute the static (non-global) inventory per surface.
 * `globalTools` (live `ctx.tools` view: subagent/delegate/jobs/skill/web/…)
 * is appended per surface — minus `CHAT_DENIED_GLOBAL_TOOLS` on chat, which
 * no longer resolves those registrations on its agent scope. Pass [] in
 * tests. `opts.chatDeny` overrides the default (tests).
 */
export function buildStaticInventory(
  globalTools: InventoryTool[] = [],
  opts: { chatDeny?: readonly string[] } = {},
): Record<InventorySurface, InventoryTool[]> {
  const chatOnly = new Set<string>(CHAT_ONLY_TOOLS as readonly string[]);
  const agentExcluded = new Set<string>(AGENT_EXCLUDED_TOOLS as readonly string[]);
  const allCairn = new Set(Object.keys(TOOL_SCHEMAS));

  // Chat registers every Cairn tool today (CHAT_FORBIDDEN_TOOLS is enforced
  // via the approval askFilter, not via exclusion) — deletes shown as gated.
  const chat = cairnTools({ gate: CHAT_GATED_TOOLS });

  // Coding registers every Cairn tool (no exclusion) + the full coding stack.
  const coding = [
    ...cairnTools({}),
    ...codingTools(CODING_ALL_TOOLS),
  ];

  // automation-dev excludes ALL Cairn data tools + every exec tool.
  const automationCairnExclude = new Set([...allCairn]);
  void automationCairnExclude;
  const automationDev = [...codingTools(AUTOMATION_DEV_TOOLS)];

  // MCP advertises every Cairn tool except chat-only ones.
  const mcp = cairnTools({ exclude: chatOnly });

  // `AGENT_EXCLUDED_TOOLS` (get_cairn_context, get_idea_flow_rules) documents
  // the legacy OpenAI-array exclusion; the Cordis loops register everything.
  // Surface it so the UI can footnote the difference instead of hiding it.
  void agentExcluded;

  const withGlobal = (list: InventoryTool[]): InventoryTool[] => [...list, ...globalTools];
  const chatDeny = new Set(opts.chatDeny ?? CHAT_DENIED_GLOBAL_TOOLS);
  const withGlobalForChat = (list: InventoryTool[]): InventoryTool[] => [
    ...list,
    ...globalTools.filter((t) => !chatDeny.has(t.name)),
  ];
  return {
    chat: withGlobalForChat(chat),
    coding: withGlobal(coding),
    "automation-dev": withGlobal(automationDev),
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
