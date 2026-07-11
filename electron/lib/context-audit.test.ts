/**
 * Context Audit — real token counts for every LLM surface: chat, pi-agent, MCP.
 *
 * Uses gpt-tokenizer's default encoder (o200k_base) — the gpt-4o encoding.
 * OpenAI serialises each tool as:
 *   {"type":"function","function":{"name":"...","description":"...","parameters":{...}}}
 * We count that exact JSON string, which matches what the API receives.
 *
 * Run:
 *   npx vitest run electron/lib/context-audit.test.ts --reporter=verbose 2>/dev/null
 */

import { describe, it } from "vitest";
import { encode } from "gpt-tokenizer";
import * as z from "zod";
import {
  TOOL_SCHEMAS,
  CHAT_ONLY_TOOLS,
  AGENT_EXCLUDED_TOOLS,
} from "./tool-schemas";
import {
  readToolDefinition,
  writeToolDefinition,
  editToolDefinition,
  bashToolDefinition,
  grepToolDefinition,
  findToolDefinition,
  lsToolDefinition,
  spawnSubagentDefinition,
} from "./coding-tools/index";
import { buildPiAgentSystemPrompt } from "./pi-agent-prompt";
import { buildSystemPrompt } from "./tools";

// ── Tokeniser ────────────────────────────────────────────────────────────────

function tok(s: string): number {
  return encode(s).length;
}

// ── Tool serialisation (mirrors what tools.ts sends to the API) ───────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function schemaToParameters(schema: z.ZodObject<z.ZodRawShape>): any {
  const json = z.toJSONSchema(schema, { target: "draft-07" }) as Record<string, unknown>;
  delete json["$schema"];
  return json;
}

interface ToolDef {
  function: { name: string; description: string; parameters?: unknown };
}

function serialiseTool(tool: ToolDef): string {
  return JSON.stringify({
    type: "function",
    function: {
      name: tool.function.name,
      description: tool.function.description,
      parameters: tool.function.parameters ?? {},
    },
  });
}

// Build OpenAI-format tool defs from TOOL_SCHEMAS
function cairnToolDef(name: string) {
  const entry = (TOOL_SCHEMAS as Record<string, { description: string; schema: z.ZodObject<z.ZodRawShape> }>)[name];
  return {
    type: "function" as const,
    function: {
      name,
      description: entry.description,
      parameters: schemaToParameters(entry.schema),
    },
  };
}

// ── Tool sets ────────────────────────────────────────────────────────────────

const CODING_DEFS: ToolDef[] = [
  readToolDefinition, writeToolDefinition, editToolDefinition, bashToolDefinition,
  grepToolDefinition, findToolDefinition, lsToolDefinition, spawnSubagentDefinition,
];

const CAIRN_TOOL_NAMES_EXECUTE = new Set([
  "get_active_context", "get_project_context_pack",
  "get_note", "ensure_note", "patch_note", "append_to_note", "search_notes",
  "get_task", "create_task", "update_task", "search_tasks", "list_ready_tasks",
  "get_idea_flow", "create_idea_flow_node", "create_idea_flow_edge",
  "ask_questions",
]);

const PLAN_MODE_ALLOWED = new Set([
  "read", "grep", "find", "ls",
  "get_active_context", "get_project_context_pack",
  "get_note", "search_notes", "get_task", "search_tasks", "list_ready_tasks",
  "ensure_note", "ask_questions",
]);

const chatOnlySet   = new Set<string>(CHAT_ONLY_TOOLS);
const agentExcluded = new Set<string>(AGENT_EXCLUDED_TOOLS);

function executeDefs(): ToolDef[] {
  const cairn = [...CAIRN_TOOL_NAMES_EXECUTE].map(cairnToolDef);
  return [...CODING_DEFS, ...cairn];
}

function planDefs(): ToolDef[] {
  const all = [...CODING_DEFS, ...[...CAIRN_TOOL_NAMES_EXECUTE].map(cairnToolDef)];
  return all.filter((d) => PLAN_MODE_ALLOWED.has(d.function.name));
}

function chatDefs(): ToolDef[] {
  return Object.keys(TOOL_SCHEMAS)
    .filter((n) => !agentExcluded.has(n))
    .map(cairnToolDef);
}

function mcpDefs(): ToolDef[] {
  return Object.keys(TOOL_SCHEMAS)
    .filter((n) => !chatOnlySet.has(n))
    .map(cairnToolDef);
}

// ── Reporting ────────────────────────────────────────────────────────────────

const W = 36; // name column width

function header(title: string) {
  console.log(`\n${"═".repeat(65)}`);
  console.log(`  ${title}`);
  console.log("═".repeat(65));
  console.log(`  ${"Tool".padEnd(W)}  ${"Tokens".padStart(7)}`);
  console.log(`  ${"─".repeat(W)}  ${"─".repeat(7)}`);
}

function row(name: string, tokens: number, note = "") {
  const bar = "▓".repeat(Math.max(1, Math.round(tokens / 8)));
  console.log(`  ${name.padEnd(W)}  ${String(tokens).padStart(7)}  ${bar} ${note}`);
}

function section(label: string) {
  console.log(`  ── ${label}`);
}

function total(tokens: number) {
  console.log(`  ${"─".repeat(W)}  ${"─".repeat(7)}`);
  console.log(`  ${"TOOLS TOTAL".padEnd(W)}  ${String(tokens).padStart(7)}`);
}

function grand(label: string, tokens: number) {
  console.log(`  ${"═".repeat(W)}  ${"═".repeat(7)}`);
  console.log(`  ${label.padEnd(W)}  ${String(tokens).padStart(7)}  ← first-turn context`);
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("Context Audit (real tokens via gpt-tokenizer / o200k_base)", () => {

  it("EXECUTE MODE — pi-agent", () => {
    const defs = executeDefs();
    header(`EXECUTE MODE  (${defs.length} tools)`);

    const coding = defs.filter((d) => CODING_DEFS.some((c) => c.function.name === d.function.name));
    const cairn  = defs.filter((d) => !coding.includes(d));

    let toolTokens = 0;
    section("Coding tools");
    for (const d of coding) {
      const t = tok(serialiseTool(d));
      toolTokens += t;
      row(d.function.name, t);
    }
    section("Cairn tools");
    for (const d of cairn) {
      const t = tok(serialiseTool(d));
      toolTokens += t;
      row(d.function.name, t);
    }
    total(toolTokens);

    const sysPrompt = buildPiAgentSystemPrompt({ projectName: "My Project", cwd: "/project", taskTitle: "Fix bug", mode: "execute" });
    const sysTokens = tok(sysPrompt);
    console.log(`\n  ${"System prompt".padEnd(W)}  ${String(sysTokens).padStart(7)}`);
    grand("GRAND TOTAL", toolTokens + sysTokens);
  });

  it("PLAN MODE — pi-agent", () => {
    const defs = planDefs();
    header(`PLAN MODE  (${defs.length} tools)`);

    let toolTokens = 0;
    for (const d of defs) {
      const t = tok(serialiseTool(d));
      toolTokens += t;
      row(d.function.name, t);
    }
    total(toolTokens);

    const sysPrompt = buildPiAgentSystemPrompt({ projectName: "My Project", cwd: "/project", mode: "plan" });
    const sysTokens = tok(sysPrompt);
    console.log(`\n  ${"System prompt".padEnd(W)}  ${String(sysTokens).padStart(7)}`);
    grand("GRAND TOTAL", toolTokens + sysTokens);
  });

  it("CHAT — inline assistant", () => {
    const defs = chatDefs();
    header(`CHAT  (${defs.length} tools)`);

    let toolTokens = 0;
    for (const d of defs) {
      const t = tok(serialiseTool(d));
      toolTokens += t;
      row(d.function.name, t);
    }
    total(toolTokens);

    const sysTokens = tok(buildSystemPrompt({ message: "", threadId: "", projectId: "p1", workspaceId: "w1" }));
    console.log(`\n  ${"System prompt".padEnd(W)}  ${String(sysTokens).padStart(7)}`);
    grand("GRAND TOTAL", toolTokens + sysTokens);
  });

  it("MCP — tools advertised to external clients", () => {
    const defs = mcpDefs();
    header(`MCP  (${defs.length} tools)`);

    let toolTokens = 0;
    for (const d of defs) {
      const t = tok(serialiseTool(d));
      toolTokens += t;
      row(d.function.name, t);
    }
    total(toolTokens);
    console.log(`\n  (MCP has no system prompt — tool list IS the context cost)`);
    grand("GRAND TOTAL", toolTokens);
  });

  it("BEFORE vs AFTER comparison across all surfaces", () => {
    console.log(`\n${"═".repeat(65)}`);
    console.log(`  BEFORE / AFTER TOKEN SAVINGS`);
    console.log("═".repeat(65));

    // ── Before tool sets ──────────────────────────────────────────────────────
    // "Before" = original tool sets before the removed-tools cleanup.
    // Deleted tools no longer exist in TOOL_SCHEMAS so we define stub defs
    // with their original descriptions/schemas inline.

    const deletedToolDefs: ToolDef[] = [
      { function: { name: "create_note",         description: "Create a note in a project.",                                      parameters: { type:"object", properties:{ projectId:{type:"string"}, title:{type:"string"}, content:{type:"string"}, tagIds:{type:"array"}, isPinned:{type:"boolean"}, folder:{type:"string"} }, required:["projectId","title"] } } },
      { function: { name: "update_note",         description: "Update a note's title, content, pinned state, or tags.",           parameters: { type:"object", properties:{ noteId:{type:"string"}, title:{type:"string"}, content:{type:"string"}, isPinned:{type:"boolean"}, tagIds:{type:"array"} }, required:["noteId"] } } },
      { function: { name: "update_task_status",  description: "Move a single task card to a different column.",                   parameters: { type:"object", properties:{ cardId:{type:"string"}, targetColumnId:{type:"string"} }, required:["cardId","targetColumnId"] } } },
      { function: { name: "list_notes",          description: "List all notes in a project.",                                     parameters: { type:"object", properties:{ projectId:{type:"string"} } } } },
      { function: { name: "list_tasks",          description: "List all tasks in a project grouped by column.",                   parameters: { type:"object", properties:{ projectId:{type:"string"}, columnType:{type:"string"}, includeArchived:{type:"boolean"} } } } },
      { function: { name: "get_project_summary", description: "Card counts by column, notes, recent activity.",                   parameters: { type:"object", properties:{ projectId:{type:"string"} }, required:["projectId"] } } },
      { function: { name: "list_recent_activity",description: "Recently created/updated notes and tasks, newest first.",          parameters: { type:"object", properties:{ workspaceId:{type:"string"}, projectId:{type:"string"}, limit:{type:"number"} } } } },
      { function: { name: "resolve_project",     description: "Find a project by name (fuzzy). Returns projectId and column IDs.",parameters: { type:"object", properties:{ name:{type:"string"}, workspaceId:{type:"string"} }, required:["name"] } } },
      { function: { name: "import_note_from_file",description: "Import a local file as a note (MCP reads from disk).",            parameters: { type:"object", properties:{ projectId:{type:"string"}, filePath:{type:"string"}, title:{type:"string"}, tagIds:{type:"array"} }, required:["projectId","filePath"] } } },
      { function: { name: "move_note",           description: "Move a note to a different project.",                              parameters: { type:"object", properties:{ noteId:{type:"string"}, targetProjectId:{type:"string"} }, required:["noteId","targetProjectId"] } } },
    ];
    const _deletedSet = new Set(deletedToolDefs.map((d) => d.function.name));

    // Chat before: all TOOL_SCHEMAS tools + deleted tools (no filtering)
    const beforeChatDefs: ToolDef[] = [
      ...Object.keys(TOOL_SCHEMAS).map(cairnToolDef),
      ...deletedToolDefs,
    ];

    const beforeExecuteDefs: ToolDef[] = [
      ...CODING_DEFS,
      ...["get_active_context","get_project_context_pack","get_note","ensure_note",
          "patch_note","append_to_note","search_notes","get_task","create_task","update_task",
          "search_tasks","list_ready_tasks","get_idea_flow","create_idea_flow_node",
          "create_idea_flow_edge","ask_questions"].map(cairnToolDef),
      ...deletedToolDefs.filter((d) => ["create_note","update_note","update_task_status","list_notes","list_tasks"].includes(d.function.name)),
    ];

    const beforePlanDefs: ToolDef[] = [
      ...["read","grep","find","ls"].map((n) => CODING_DEFS.find((d) => d.function.name === n)!),
      ...["get_active_context","get_project_context_pack","get_note","search_notes",
          "get_task","search_tasks","list_ready_tasks","ensure_note","ask_questions"].map(cairnToolDef),
      ...deletedToolDefs.filter((d) => ["list_notes","list_tasks"].includes(d.function.name)),
    ];

    // MCP before: all TOOL_SCHEMAS tools + deleted tools, minus chat-only
    const beforeMcpDefs: ToolDef[] = [
      ...Object.keys(TOOL_SCHEMAS).filter((n) => !chatOnlySet.has(n)).map(cairnToolDef),
      ...deletedToolDefs.filter((d) => !chatOnlySet.has(d.function.name)),
    ];

    // ── Before system prompts ─────────────────────────────────────────────────
    // Reconstructed from git diff — the original chat system prompt text.
    const beforeChatSysPrompt = `You are the Cairn AI assistant — an intelligent helper embedded inside a note-taking and project management app.

## How to get context
Call get_active_context first whenever you need IDs (projectId, columnId, workspaceId, noteId). Never ask the user for IDs.
Call get_cairn_context once if you need a full tool/convention reference.

## Instructions
- Call get_active_context before any write operation or when you need IDs
- For write operations call the tool directly — no confirmation needed
- After a write, briefly confirm what you did
- Use **bold** for key items, bullet lists for multiple items
- Keep responses concise and actionable

## Notes
- Notes live in a project. Use create_note or ensure_note to create them.
- Use the optional \`folder\` parameter to place a note in a subfolder, e.g. \`folder="Research/Papers"\`. Nested paths are supported.
- list_notes returns a \`folder\` field on each note so you can inspect the current folder structure before deciding where to place a new note.
- Omit \`folder\` or pass \`folder=""\` to place the note in the project root.

## Tasks and dependencies
- Use list_ready_tasks instead of list_tasks when sequencing work — it returns only tasks with no pending blockers
- Use block_task to mark a task as blocked by another in the same project. Circular dependencies are rejected automatically
- Use unblock_task to remove a dependency. Blockers are also auto-resolved when the blocker card is moved to a done column or archived

## Dashboards
Create interactive HTML dashboards with create_dashboard. Call get_dashboard_constants for the window.cairn API reference before writing dashboard HTML.

## Idea Flow
Each project has a visual node canvas. Call get_idea_flow_rules for node type data shapes and group conventions before creating nodes. Always use spatial.nextPosition from get_idea_flow as the base position for new nodes.

## Knowledge Graph
Call get_knowledge_graph for cross-entity research. Call get_neighbors for focused N-hop traversal from a single node — more efficient than loading the full graph.

Tone: calm, focused, like a thoughtful co-worker.`;

    // ── Totals (tools + system prompt) ───────────────────────────────────────
    function sumTok(defs: ToolDef[]) { return defs.reduce((s, d) => s + tok(serialiseTool(d)), 0); }

    const afterChatSysPrompt = buildSystemPrompt({ message: "", threadId: "", projectId: "p1", workspaceId: "w1" });
    const afterPiExecuteSys  = buildPiAgentSystemPrompt({ projectName: "My Project", cwd: "/project", taskTitle: "Fix bug", mode: "execute" });
    const afterPiPlanSys     = buildPiAgentSystemPrompt({ projectName: "My Project", cwd: "/project", mode: "plan" });
    // pi-agent system prompts haven't changed in before/after for this audit — use same for before
    const beforePiSys = afterPiExecuteSys;
    const beforePiPlanSys = afterPiPlanSys;

    const surfaces: [string, number, number][] = [
      ["Execute (pi-agent)", sumTok(beforeExecuteDefs) + tok(beforePiSys),     sumTok(executeDefs()) + tok(afterPiExecuteSys)],
      ["Plan (pi-agent)",    sumTok(beforePlanDefs)    + tok(beforePiPlanSys), sumTok(planDefs())    + tok(afterPiPlanSys)],
      ["Chat",               sumTok(beforeChatDefs)    + tok(beforeChatSysPrompt), sumTok(chatDefs()) + tok(afterChatSysPrompt)],
      ["MCP",                sumTok(beforeMcpDefs),                            sumTok(mcpDefs())],
    ];

    console.log(`\n  ${"Surface".padEnd(22)}  ${"Before".padStart(7)}  ${"After".padStart(7)}  ${"Saved".padStart(7)}  ${"% cut"}`);
    console.log(`  ${"─".repeat(22)}  ${"─".repeat(7)}  ${"─".repeat(7)}  ${"─".repeat(7)}  ${"─".repeat(6)}`);

    for (const [label, b, a] of surfaces) {
      const saved = b - a;
      const pct = ((saved / b) * 100).toFixed(1);
      console.log(`  ${label.padEnd(22)}  ${String(b).padStart(7)}  ${String(a).padStart(7)}  ${String(saved).padStart(7)}  ${pct}%`);
    }

    const tools_before = beforeExecuteDefs.length;
    const tools_after  = executeDefs().length;
    console.log(`\n  Execute tool count: ${tools_before} → ${tools_after} tools (−${tools_before - tools_after})`);
    console.log(`  (Before/After totals include system prompt tokens on all surfaces)`);
  });
});
