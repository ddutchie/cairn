/**
 * Cairn — AI tool definitions and system prompt builder
 *
 * TOOLS array is derived from tool-schemas.ts via z.toJSONSchema().
 * Do not hand-edit tool parameters here — edit tool-schemas.ts instead.
 */

import path from "path";
import * as z from "zod";
import { TOOL_SCHEMAS, CHAT_ONLY_TOOLS, type ToolName } from "./tool-schemas";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ToolArgs = Record<string, any>;

// Human-readable labels for each tool call, shown in the UI
export const TOOL_LABELS: Record<string, (args: ToolArgs) => string> = {
  get_cairn_context:          () => "Reading workspace context",
  get_project_context_pack:   () => "Reading project context pack",
  resolve_project:            (a) => `Resolving project "${a.name}"`,
  get_active_context:         () => "Reading active context",
  get_note:               () => `Reading note`,
  list_notes:             () => "Listing notes",
  list_tasks:             () => "Listing tasks",
  search_notes:           (a) => `Searching notes for "${a.query}"`,
  search_tasks:           (a) => `Searching tasks for "${a.query}"`,
  get_project_summary:    () => "Reading project summary",
  get_task:               () => "Reading task",
  create_note:            (a) => `Creating note "${a.title}"`,
  import_note_from_file:  (a) => `Importing ${path.basename(a.filePath as string)} as note`,
  ensure_note:            (a) => `Ensuring note "${a.title}"`,
  append_to_note:         () => "Appending to note",
  patch_note:             () => "Patching note",
  update_note:            () => "Updating note",
  create_task:            (a) => `Creating task "${a.title}"`,
  update_task_status:        () => "Moving task",
  bulk_update_task_status:   (a) => `Moving ${(a.cardIds as string[])?.length ?? 0} tasks`,
  update_task:            () => "Updating task",
  block_task:             (a) => `Blocking task`,
  unblock_task:           (a) => `Unblocking task`,
  list_ready_tasks:       () => "Listing ready tasks",
  create_project:         (a) => `Creating project "${a.name}"`,
  update_project:         (a) => `Updating project "${a.projectId}"`,
  delete_project:         (a) => `Deleting project "${a.projectId}"`,
  list_recent_activity:   () => "Listing recent activity",
  delete_note:            () => "Deleting note",
  delete_task:            () => "Deleting task",
  generate_prd:           (a) => `Generating PRD "${a.title}"`,
  spawn_tasks_from_note:  () => "Spawning tasks from note",
  link_note_to_task:      () => "Linking note to task",
  move_note:              (a) => `Moving note to project`,
  get_idea_flow:          (a) => `Reading Idea Flow`,
  create_idea_flow_node:  (a) => `Adding ${(a.type as string) ?? "node"} to Idea Flow`,
  update_idea_flow_node:  () => "Updating Idea Flow node",
  delete_idea_flow_node:  () => "Removing node from Idea Flow",
  create_idea_flow_edge:  () => "Connecting nodes in Idea Flow",
  delete_idea_flow_edge:  () => "Removing connection from Idea Flow",
  layout_idea_flow:       () => "Auto-arranging Idea Flow",
  get_knowledge_graph:    () => "Reading knowledge graph",
  get_neighbors:          (a) => `Getting neighbours of ${(a.nodeId as string) ?? "node"}`,
  create_tag:             (a) => `Creating tag "${a.name}"`,
  create_dashboard:       (a) => `Creating dashboard "${a.title}"`,
  update_dashboard:       () => "Updating dashboard",
  get_dashboard_constants: () => "Reading dashboard API reference",
  get_idea_flow_rules:    () => "Reading Idea Flow rules",
};

// Tool definitions for the AI (OpenAI function calling format)
// Derived from TOOL_SCHEMAS — do not edit manually.
function schemaToParameters(schema: z.ZodObject<z.ZodRawShape>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const json = z.toJSONSchema(schema, { target: "draft-07" }) as any;
  // Strip $schema header — not needed in OpenAI function parameters
  delete json["$schema"];
  return json;
}

export const TOOLS = (Object.entries(TOOL_SCHEMAS) as [ToolName, (typeof TOOL_SCHEMAS)[ToolName]][]).map(
  ([name, { description, schema }]) => ({
    type: "function" as const,
    function: {
      name,
      description,
      parameters: schemaToParameters(schema as z.ZodObject<z.ZodRawShape>),
    },
  })
);

// Keep a compile-time check that TOOL_SCHEMAS covers the expected set
void CHAT_ONLY_TOOLS;


export interface ChatRequest {
  message: string;
  threadId: string;
  projectId?: string;
  workspaceId?: string;
  history?: Array<{ role: "user" | "assistant" | "system"; content: string }>;
  config?: { baseUrl?: string; model?: string; apiKey?: string; maxSteps?: number };
}

export function buildSystemPrompt(req: ChatRequest): string {
  return `You are the Cairn AI assistant — an intelligent helper embedded inside a note-taking and project management app.

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
}
