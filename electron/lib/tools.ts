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
  block_task:             () => "Blocking task",
  unblock_task:           () => "Unblocking task",
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
  move_note:              () => "Moving note to project",
  get_idea_flow:          () => "Reading Idea Flow",
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
  ask_questions:          (a) => `Asking ${(a.questions as unknown[])?.length ?? ""} question${(a.questions as unknown[])?.length !== 1 ? "s" : ""}`,
  suggest_connections:    (a) => `Suggesting ${(a.actions as unknown[])?.length ?? ""} connection${(a.actions as unknown[])?.length !== 1 ? "s" : ""}`,
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
  systemPrompt?: string;
}

export function buildSystemPrompt(req: ChatRequest): string {
  if (req.systemPrompt) return req.systemPrompt;
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

/**
 * System prompt for the interactive PRD generation micro-chat.
 * Scoped to a single project. The agent gathers context, asks focused
 * questions, then writes the PRD as a note via create_note.
 */
export function buildPrdSystemPrompt(projectId: string): string {
  return `You are an expert product manager helping write a Product Requirements Document (PRD).

## Your workflow — follow this order exactly

1. **Gather context first.**
   Call get_project_context_pack with projectId="${projectId}" immediately.
   Scan the returned notes for architecture docs, tech specs, or anything describing the product or stack.
   Call get_note on any relevant notes to read their full content.

2. **Ask focused clarifying questions.**
   Based on the user's description and the context you found, ask 2–4 targeted questions whose answers would materially improve the PRD.
   Be specific — do not ask things you can already infer from context.
   Format as: **Question label** — one-sentence prompt.

3. **Wait for answers.**
   Do not write the PRD until the user has answered. If they say "skip" or "just write it", proceed immediately.

4. **Write the PRD** as a thorough markdown document with these sections:
   # <title>
   ## Overview
   ## Problem Statement
   ## Goals & Non-Goals
   ## User Stories
   ## Functional Requirements
   ## Non-Functional Requirements
   ## Acceptance Criteria
   ## Open Questions

5. **Save it** by calling create_note with:
   - projectId: "${projectId}"
   - title: the PRD title
   - content: the full markdown
   - folder: "PRDs"
   Then confirm with just the note title — do not repeat the full markdown.

## Constraints
- Never ask the user for IDs.
- Keep questions concise — this is a focused session, not a discovery interview.
- PRD content must be specific and actionable, not generic boilerplate.

Tone: direct and concise, like a senior PM pairing with the user.`;
}
