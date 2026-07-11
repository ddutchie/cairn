/**
 * Cairn — AI tool definitions and system prompt builder
 *
 * TOOLS array is derived from tool-schemas.ts via z.toJSONSchema().
 * Do not hand-edit tool parameters here — edit tool-schemas.ts instead.
 */

import * as z from "zod";
import { TOOL_SCHEMAS, CHAT_ONLY_TOOLS, AGENT_EXCLUDED_TOOLS } from "./tool-schemas";
import type { ToolName } from "./tool-schemas";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ToolArgs = Record<string, any>;

// Human-readable labels for each tool call, shown in the UI
export const TOOL_LABELS: Record<string, (args: ToolArgs) => string> = {
  get_cairn_context:          () => "Reading workspace context",
  get_project_context_pack:   () => "Reading project context pack",
  get_active_context:         () => "Reading active context",
  get_note:               () => "Reading note",
  search_notes:           (a) => `Searching notes for "${a.query}"`,
  search_notes_semantic:  (a) => `Semantic search for "${a.query}"`,
  search_tasks:           (a) => `Searching tasks for "${a.query}"`,
  get_task:               () => "Reading task",
  ensure_note:            (a) => `Ensuring note "${a.title}"`,
  append_to_note:         () => "Appending to note",
  patch_note:             () => "Patching note",
  create_task:            (a) => `Creating task "${a.title}"`,
  bulk_update_task_status:   (a) => `Moving ${(a.cardIds as string[])?.length ?? 0} tasks`,
  update_task:            (a) => a.archived === true ? "Archiving task" : a.archived === false ? "Restoring task" : a.blockedBy ? "Blocking task" : a.unblockFrom ? "Unblocking task" : "Updating task",
  list_ready_tasks:       () => "Listing ready tasks",
  upsert_project:         (a) => a.projectId ? `Updating project "${a.projectId}"` : `Creating project "${a.name}"`,
  delete_project:         (a) => `Deleting project "${a.projectId}"`,
  delete_note:            () => "Deleting note",
  rename_note:            (a) => `Renaming note to "${a.newTitle}"`,
  bulk_move_notes:        (a) => `Moving ${(a.noteIds as string[])?.length ?? 0} notes`,
  list_folders:           () => "Listing subfolders",
  delete_task:            () => "Deleting task",
  generate_prd:           (a) => `Generating PRD "${a.title}"`,
  spawn_tasks_from_note:  () => "Spawning tasks from note",
  link_note_to_task:      () => "Linking note to task",
  unlink_note_from_task:   () => "Unlinking note from task",
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
  codebase_reindex:               (a) => `Indexing codebase folder "${a.folder}"`,
  codebase_search_symbols:        (a) => `Searching codebase symbols for "${a.query}"`,
  codebase_get_symbol_definition: (a) => `Getting definition of symbol "${a.name}"`,
  codebase_get_references:        (a) => `Finding references for symbol "${a.name}"`,
  codebase_get_file_symbols:      (a) => `Listing symbols in "${a.filePath}"`,
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

const _agentExcluded = new Set<string>(AGENT_EXCLUDED_TOOLS);

export const TOOLS = (Object.entries(TOOL_SCHEMAS) as [ToolName, (typeof TOOL_SCHEMAS)[ToolName]][])
  .filter(([name]) => !_agentExcluded.has(name))
  .map(([name, { description, schema }]) => ({
    type: "function" as const,
    function: {
      name,
      description,
      parameters: schemaToParameters(schema as z.ZodObject<z.ZodRawShape>),
    },
  }));

// Keep a compile-time check that TOOL_SCHEMAS covers the expected set
void CHAT_ONLY_TOOLS;


export interface ChatHistoryEntry {
  role: "user" | "assistant" | "system" | "tool";
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
    thought_signature?: string;
  }>;
  tool_call_id?: string;
  name?: string;
}

export interface ChatRequest {
  message: string;
  threadId: string;
  projectId?: string;
  workspaceId?: string;
  history?: ChatHistoryEntry[];
  config?: { baseUrl?: string; model?: string; apiKey?: string; maxSteps?: number; temperature?: number };
  systemPrompt?: string;
  images?: Array<{ name: string; dataUrl: string }>;
}

export function buildSystemPrompt(req: ChatRequest): string {
  if (req.systemPrompt) return req.systemPrompt;
  const date = new Date().toLocaleDateString("en-US", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
  });
  // Kept deliberately lean: tool *descriptions* (always sent in the tools array)
  // carry per-tool guidance and parameters, so this prompt only holds the
  // cross-cutting rules that no single tool description can express. A live
  // experiment (see note "AI Agent Identity & System Prompts") showed this ~110-
  // token prompt matches/beats the previous ~960-token one for tool selection.
  return `You are the Cairn AI assistant — an intelligent helper embedded inside a note-taking and project management app. Today is ${date}.

Use the provided tools to read and modify the user's workspace. Choose the tool whose description matches the request — each tool documents its own parameters and behaviour (idempotency, folders, tagNames, blockers, dashboard constants, inline note/task creation, etc.).

- **IDs:** Call get_active_context once at the start (or after a project change) to obtain workspaceId/projectId/columnId; reuse them. Never invent or ask the user for IDs.
- **Writes:** Call the tool directly (no confirmation needed), then briefly confirm what you did.
- **Suggesting connections:** When proposing new links, wikilinks, note↔card links, or tags, you MUST call \`suggest_connections\` (the UI renders "Apply" buttons) rather than describing them in prose.
- **Rendering:** Replies are markdown — use bold, lists, tables, fenced code (with language), and mermaid fenced blocks for diagrams. Keep replies concise and actionable.

Tone: calm, focused, like a thoughtful co-worker.`;
}

/**
 * System prompt for the interactive PRD generation micro-chat.
 * Scoped to a single project. The agent gathers context, asks focused
 * questions, then writes the PRD as a note via ensure_note.
 */
export function buildPrdSystemPrompt(projectId: string): string {
  const date = new Date().toLocaleDateString("en-US", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
  });
  return `You are an expert product manager helping write a Product Requirements Document (PRD).

## Context
- **Date:** ${date}

## RENDERING CAPABILITIES:
- You have access to the following markdown rendering features:
  - **Mermaid Diagrams**: Use mermaid fenced code blocks for flowcharts or sequence diagrams.
  - **Tables**: Use standard markdown table syntax for data representation.
  - **Code Blocks**: Specify the language (e.g., typescript) for syntax highlighting.
  - **Standard Formatting**: Bold, italic, bulleted/numbered lists, and links.

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

5. **Save it** by calling ensure_note with:
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
