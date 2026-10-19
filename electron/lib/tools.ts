/**
 * Cairn — AI tool definitions and system prompt builder
 *
 * TOOLS array is derived from tool-schemas.ts via z.toJSONSchema().
 * Do not hand-edit tool parameters here — edit tool-schemas.ts instead.
 */

import { TOOL_SCHEMAS, CHAT_ONLY_TOOLS, toolParametersJsonSchema } from "./tool-schemas";
import { MAX_PERSONALITY_PROMPT_CHARS } from "../../shared/chat/registry-schema";
import type { ToolName } from "./tool-schemas";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ToolArgs = Record<string, any>;

// Human-readable labels for each tool call, shown in the UI
export const TOOL_LABELS: Record<string, (args: ToolArgs) => string> = {
  get_context:            (a) => a.projectId ? "Reading project context" : "Reading workspace context",
  get_item:               () => "Reading item",
  search_notes:           (a) => `${a.mode === "semantic" ? "Semantic search" : "Searching notes"} for "${a.query}"`,
  search_tasks:           (a) => a.filter ? `Listing ${a.filter} tasks` : `${a.mode === "semantic" ? "Semantic task search" : "Searching tasks"} for "${a.query}"`,
  ensure_note:            (a) => a.templateId ? `Creating note "${a.title}" from template` : `Ensuring note "${a.title}"`,
  edit_note:              (a) => a.oldString ? "Editing note" : "Appending to note",
  update_notes:           (a) => {
    const n = (a.noteIds as string[] | undefined)?.length ?? 0;
    return a.title ? `Renaming note to "${a.title}"` : a.folder !== undefined ? `Moving ${n} note${n === 1 ? "" : "s"}` : `Updating ${n} note${n === 1 ? "" : "s"}`;
  },
  create_task:            (a) => `Creating task "${a.title}"`,
  update_tasks:           (a) => {
    const n = (a.cardIds as string[] | undefined)?.length ?? 0;
    if (a.archived === true) return "Archiving task";
    if (a.archived === false) return "Restoring task";
    if (a.columnType || a.columnId) return `Moving ${n} task${n === 1 ? "" : "s"}`;
    return `Updating ${n} task${n === 1 ? "" : "s"}`;
  },
  task_progress:          (a) => a.action === "claim" ? `Claiming task as ${a.agent ?? "agent"}` : a.moveTo ? `Logging progress (→ ${a.moveTo})` : "Logging task progress",
  upsert_project:         (a) => a.projectId ? `Updating project "${a.projectId}"` : `Creating project "${a.name}"`,
  delete:                 (a) => `Deleting ${String(a.type ?? "item").replace("flow_", "Idea Flow ")}`,
  get_idea_flow:          () => "Reading Idea Flow",
  edit_idea_flow:         (a) => `Editing Idea Flow (${(a.ops as unknown[] | undefined)?.length ?? 0} change${(a.ops as unknown[] | undefined)?.length === 1 ? "" : "s"})`,
  get_graph:              (a) => a.nodeId ? (a.semantic ? "Finding related notes" : `Getting neighbours of ${a.nodeId}`) : "Reading knowledge graph",
  get_user_writing_style:     (a) => (a.mode === "full" ? "Reading your full writing style" : "Reading your writing style cheat sheet"),
  update_user_writing_style:  (a) => a.section ? `Updating writing style (${a.section})` : "Updating writing style",
  codebase_reindex:       (a) => `Indexing codebase folder "${a.folder}"`,
  codebase_query:         (a) => `Codebase ${a.action ?? "query"}: "${a.query}"`,
  ask_questions:          (a) => `Asking ${(a.questions as unknown[])?.length ?? ""} question${(a.questions as unknown[])?.length !== 1 ? "s" : ""}`,
  suggest_connections:    (a) => `Suggesting ${(a.actions as unknown[])?.length ?? ""} connection${(a.actions as unknown[])?.length !== 1 ? "s" : ""}`,
  render_ui:              (a) => a.title ? `Showing UI: ${a.title}` : "Showing interactive UI",
  spawn_tasks_from_note:  () => "Spawning tasks from note",
};

// Tool definitions for the AI (OpenAI function calling format)
// Derived from TOOL_SCHEMAS — do not edit manually.
export const TOOLS = (Object.entries(TOOL_SCHEMAS) as [ToolName, (typeof TOOL_SCHEMAS)[ToolName]][])
  .map(([name, { description, schema }]) => ({
    type: "function" as const,
    function: {
      name,
      description,
      parameters: toolParametersJsonSchema(schema),
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
  /** Reasoning round-trip metadata (persisted on chat_messages). */
  reasoning?: string;
  reasoningField?: string;
  reasoningModel?: string;
  reasoningItems?: Array<Record<string, unknown>>;
}

export interface ChatRequest {
  message: string;
  threadId: string;
  projectId?: string;
  workspaceId?: string;
  history?: ChatHistoryEntry[];
  config?: { baseUrl?: string; model?: string; apiKey?: string; maxSteps?: number; temperature?: number; maxTokens?: number; isReasoningModel?: boolean; reasoningEffort?: "off" | "low" | "medium" | "high"; apiMode?: "responses" | "completions" | "anthropic-messages"; contextLimit?: number; contextWindow?: number };
  systemPrompt?: string;
  /**
   * Active chat personality for this turn — a style layer appended verbatim
   * after the system prompt. `name` is the display label; `prompt` holds the
   * behavioral rules. Absent = no personality (default Cairn behavior).
   */
  personality?: { name: string; prompt: string };
  /** Chat approval policy for this turn (see shared/agent/chat-approval.ts). Absent → the saved setting. */
  approvalPolicy?: import("../../shared/agent/chat-approval").ChatApprovalPolicy;
  /** Attachments on the current user message (base64 data URLs; kind="pdf"
   *  becomes an Anthropic-style `document` part, images become `image_url`). */
  images?: Array<{ name: string; dataUrl: string; kind?: "image" | "pdf" }>;
  /** When true, run the dispatch → research/write subagent loop instead of the single-agent tool loop. */
  useSubagents?: boolean;
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

Use the provided tools to read and modify the user's workspace. Choose the tool whose description matches the request — each tool documents its own parameters and behaviour (idempotency, folders, tagNames, blockers, inline note/task creation, etc.).

- **IDs:** Call get_context once at the start (or after a project change) to obtain workspaceId/projectId/columnId; reuse them. Never invent or ask the user for IDs.
- **Writes:** Call the tool directly (no confirmation needed), then briefly confirm what you did.
- **Suggesting connections:** When proposing new links, wikilinks, note↔card links, or tags, you MUST call \`suggest_connections\` (the UI renders "Apply" buttons) rather than describing them in prose.
- **Rendering:** Replies are markdown — use bold, lists, tables, fenced code (with language), and mermaid fenced blocks for diagrams. Keep replies concise and actionable.
- **Writing in the user's voice:** When the user asks you to draft or rewrite content that sounds like them (emails, replies, notes, PRDs), call \`get_user_writing_style\` first and match it. If it reports configured:false, write in a natural, clear voice instead. When the user explicitly asks you to remember a style preference, call \`update_user_writing_style\` (append) — do not invent preferences.

Tone: calm, focused, like a thoughtful co-worker.`;
}

/**
 * Append the active chat personality to a built system prompt as a clearly
 * delimited style LAYER. A personality is never a replacement identity — the
 * base "You are the Cairn AI assistant" prompt stays intact and the behavioral
 * rules are added under their own header so the model treats them as session
 * style guidance rather than a conflicting persona.
 */
export function withPersonality(
  systemPrompt: string,
  personality?: { name: string; prompt: string },
): string {
  if (!personality || !personality.name || !personality.prompt) return systemPrompt;
  // Guard the appended layer against an oversized prompt (same shared ceiling
  // the registry schema + create forms enforce — truncate defensively so an
  // over-long persisted prompt can't bloat the system prompt).
  const prompt = personality.prompt.length > MAX_PERSONALITY_PROMPT_CHARS
    ? personality.prompt.slice(0, MAX_PERSONALITY_PROMPT_CHARS)
    : personality.prompt;
  return `${systemPrompt}\n\n## Personality: ${personality.name}\n${prompt}`;
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
   Call get_context with projectId="${projectId}" immediately.
   Scan the returned notes for architecture docs, tech specs, or anything describing the product or stack.
   Call get_item on any relevant notes to read their full content.

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
