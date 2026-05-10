/**
 * Cairn — Unified tool schema definitions (Zod)
 *
 * Single source of truth for all tool schemas used by both the AI chat loop
 * (tools.ts → OpenAI function-calling format) and the MCP server
 * (mcp-server.ts → McpServer.tool()).
 *
 * Usage:
 *   import { TOOL_SCHEMAS } from "./tool-schemas";
 *   // Chat: z.toJSONSchema(schema) → parameters object
 *   // MCP:  server.tool(name, desc, schema) directly
 */

import * as z from "zod";

// ── Shared field shapes ────────────────────────────────────────────────────────

const sId          = z.string();
const sIdOpt       = z.string().optional();
const sStr         = z.string();
const sStrOpt      = z.string().optional();
const sNumOpt      = z.number().optional();
const sBoolOpt     = z.boolean().optional();
const sTagIds      = z.array(z.string()).optional().describe("Tag IDs (from get_active_context)");
const sPriority    = z.enum(["low", "medium", "high", "urgent"]).optional();
const sStatus      = z.enum(["active", "on_hold", "completed", "archived"]).optional();
const sColType     = z.enum(["backlog", "todo", "in_progress", "review", "done"]).optional();
const sDueDate     = z.string().optional().describe("ISO date e.g. 2026-05-01, or empty to clear");
const sColor       = z.string().optional().describe("Hex colour e.g. #6366f1");

// ── Tool schema map ────────────────────────────────────────────────────────────
// Each entry: { description, schema (Zod object shape for McpServer.tool) }
// tools.ts derives the OpenAI TOOLS array from these via z.toJSONSchema().

export const TOOL_SCHEMAS = {

  // ── Read / context ───────────────────────────────────────────────────────────

  get_cairn_context: {
    description: "Full workspace orientation: projects, columns, tags, conventions. Call once at MCP session start.",
    schema: z.object({}),
  },

  get_project_context_pack: {
    description: "Project metadata, columns, pinned notes, open tasks, recent activity in one call.",
    schema: z.object({ projectId: sId }),
  },

  get_active_context: {
    description: "Active workspace, project, column IDs, recent notes/tasks, and tags. Call first to get IDs.",
    schema: z.object({}),
  },

  get_note: {
    description: "Get the full content of a note by ID.",
    schema: z.object({ noteId: sId }),
  },

  search_notes: {
    description: "Search notes by text query. Empty query returns all notes.",
    schema: z.object({
      query:     sStr,
      projectId: sIdOpt,
      limit:     z.number().optional().default(10),
    }),
  },

  search_tasks: {
    description: "Search tasks by text query. Empty query returns all tasks.",
    schema: z.object({
      query:      sStr,
      projectId:  sIdOpt,
      columnType: sColType,
      limit:      z.number().optional().default(10),
    }),
  },

  get_task: {
    description: "Task card detail: title, description, priority, dueDate, column, linked notes.",
    schema: z.object({ cardId: sId }),
  },

  // ── Notes ────────────────────────────────────────────────────────────────────

  ensure_note: {
    description: "Create-or-update a note by title+projectId. Idempotent — safe to call repeatedly.",
    schema: z.object({
      projectId: sId,
      title:     sStr,
      content:   sStrOpt,
      tagIds:    sTagIds,
      isPinned:  sBoolOpt,
      folder:    sStrOpt.describe("Subfolder path. Empty = project root."),
    }),
  },

  append_to_note: {
    description: "Append text to a note without replacing existing content.",
    schema: z.object({
      noteId:    sId,
      content:   sStr,
      separator: sStrOpt.describe("Between existing and new content (default: blank line)"),
    }),
  },

  patch_note: {
    description: "Replace an exact string inside a note. Include surrounding context to make oldString unique.",
    schema: z.object({
      noteId:     sId,
      oldString:  sStr,
      newString:  sStr,
      replaceAll: sBoolOpt,
    }),
  },

  delete_note: {
    description: "Permanently delete a note. Cannot be undone.",
    schema: z.object({ noteId: sId }),
  },

  // ── Tasks ─────────────────────────────────────────────────────────────────────

  create_task: {
    description: "Create a task card in a board column.",
    schema: z.object({
      columnId:    sId,
      projectId:   sId,
      title:       sStr,
      description: sStrOpt,
      priority:    sPriority,
      dueDate:     sDueDate,
      tagIds:      sTagIds,
    }),
  },

  update_task: {
    description: "Update a task card's fields. Only provided fields are changed.",
    schema: z.object({
      cardId:      sId,
      title:       sStrOpt,
      description: sStrOpt,
      priority:    sPriority,
      dueDate:     sDueDate,
      columnId:    sIdOpt.describe("Move to this column"),
      assignee:    sStrOpt.describe("Assignee name, or empty to clear"),
      tagIds:      sTagIds,
    }),
  },

  bulk_update_task_status: {
    description: "Move multiple task cards to the same column in one call.",
    schema: z.object({
      cardIds:        z.array(z.string()).describe("Task card IDs to move"),
      targetColumnId: sId,
    }),
  },

  delete_task: {
    description: "Permanently delete a task card. Cannot be undone.",
    schema: z.object({ cardId: sId }),
  },

  archive_task: {
    description: "Archive a task card so it no longer appears in the active board. Use instead of delete when the work is done but you may want to reference it later.",
    schema: z.object({ cardId: sId }),
  },

  restore_task: {
    description: "Restore a previously archived task card back to the active board.",
    schema: z.object({ cardId: sId }),
  },

  link_note_to_task: {
    description: "Bidirectionally link a note and a task card.",
    schema: z.object({
      noteId: sId,
      cardId: sId,
    }),
  },

  block_task: {
    description: "Mark a task as blocked by another task in the same project. The blocked task will not appear in list_ready_tasks until the blocker is resolved (moved to done or archived). Circular dependencies are rejected.",
    schema: z.object({
      cardId:        sId.describe("The task to mark as blocked"),
      blockerCardId: sId.describe("The task that is blocking it"),
    }),
  },

  unblock_task: {
    description: "Remove a blocking dependency between two tasks.",
    schema: z.object({
      cardId:        sId.describe("The blocked task"),
      blockerCardId: sId.describe("The blocker to remove"),
    }),
  },

  list_ready_tasks: {
    description: "Return only unblocked, active tasks — tasks with no pending blockers and not in a done column. Use this instead of list_tasks when you want to know what work can start right now.",
    schema: z.object({
      projectId: sId.optional(),
    }),
  },

  // ── Projects ──────────────────────────────────────────────────────────────────

  create_project: {
    description: "Create a project with default columns (Backlog, Todo, In Progress, Review, Done).",
    schema: z.object({
      workspaceId: sId,
      name:        sStr,
      description: sStrOpt,
      icon:        sStrOpt.describe("Single emoji"),
      status:      sStatus,
      priority:    sPriority,
    }),
  },

  update_project: {
    description: "Update a project's name, description, icon, status, or priority.",
    schema: z.object({
      projectId:   sId,
      name:        sStrOpt,
      description: sStrOpt,
      icon:        sStrOpt.describe("Single emoji"),
      status:      sStatus,
      priority:    sPriority,
    }),
  },

  delete_project: {
    description: "Permanently delete a project and all its contents. Cannot be undone.",
    schema: z.object({ projectId: sId }),
  },

  // ── Dashboards ────────────────────────────────────────────────────────────────

  create_dashboard: {
    description: "Create a live HTML dashboard. html must be a self-contained document with inline CSS/JS. Call get_dashboard_constants for the window.cairn API reference.",
    schema: z.object({
      projectId: sId,
      title:     sStr,
      html:      sStr.describe("Self-contained HTML with inline CSS/JS"),
    }),
  },

  update_dashboard: {
    description: "Update a dashboard's title or HTML.",
    schema: z.object({
      noteId: sId,
      title:  sStrOpt,
      html:   sStrOpt,
    }),
  },

  get_dashboard_constants: {
    description: "Returns the window.cairn API reference for building dashboards: available helper functions, return shapes, and usage examples. Call before writing dashboard HTML.",
    schema: z.object({}),
  },

  // ── AI tools (chat-only) ──────────────────────────────────────────────────────

  generate_prd: {
    description: "Generate a PRD note from a plain-language description.",
    schema: z.object({
      projectId:    sId,
      title:        sStr,
      requirements: sStr.describe("Plain-language description of what to build"),
    }),
  },

  spawn_tasks_from_note: {
    description: "Read a PRD/spec note and create task cards from it. Links tasks to the note.",
    schema: z.object({
      noteId:   sId,
      columnId: sId.describe("Column for new tasks (Backlog by default)"),
    }),
  },

  // ── Idea Flow ─────────────────────────────────────────────────────────────────

  get_idea_flow: {
    description: "Get the Idea Flow graph: nodes (with note/task content), edges, spatial bounds, and nextPosition. Call before making changes. Call get_idea_flow_rules for node type and group conventions.",
    schema: z.object({ projectId: sId }),
  },

  create_idea_flow_node: {
    description: "Add a node to the Idea Flow. Types: idea, note_ref, task_ref, url, ai_summary, group. edges[] wires connections in the same call.",
    schema: z.object({
      projectId: sId,
      type:      z.enum(["idea", "note_ref", "task_ref", "group", "url", "ai_summary"]),
      x:         sNumOpt,
      y:         sNumOpt,
      width:     sNumOpt,
      height:    sNumOpt,
      parentId:  sIdOpt.describe("Parent group node ID"),
      data:      z.object({}).passthrough().optional().describe("idea={title,body} note_ref={noteId} task_ref={cardId} group={label?,color?} url={url,title?,description?} ai_summary={content}"),
      edges:     z.array(z.object({}).passthrough()).optional().describe("[{targetNodeId,label?}] or [{sourceNodeId,label?}]"),
    }),
  },

  update_idea_flow_node: {
    description: "Update a node's data and/or position. data fields are merged, not replaced.",
    schema: z.object({
      nodeId: sId,
      x:      sNumOpt,
      y:      sNumOpt,
      width:  sNumOpt,
      height: sNumOpt,
      data:   z.object({}).passthrough().optional().describe("Partial data to merge"),
    }),
  },

  delete_idea_flow_node: {
    description: "Delete a node and all its edges from the Idea Flow.",
    schema: z.object({ nodeId: sId }),
  },

  create_idea_flow_edge: {
    description: "Connect two Idea Flow nodes.",
    schema: z.object({
      sourceNodeId: sId,
      targetNodeId: sId,
      label:        sStrOpt,
    }),
  },

  delete_idea_flow_edge: {
    description: "Remove an Idea Flow edge.",
    schema: z.object({ edgeId: sId }),
  },

  layout_idea_flow: {
    description: "Auto-arrange Idea Flow nodes with Dagre. Call after bulk-creating nodes.",
    schema: z.object({
      projectId: sId,
      direction: z.enum(["LR", "TB"]).optional().describe("LR (default) or TB"),
    }),
  },

  get_idea_flow_rules: {
    description: "Returns Idea Flow conventions: node type data shapes, group rules, spatial positioning. Call before creating nodes if unfamiliar.",
    schema: z.object({}),
  },

  // ── Knowledge Graph ───────────────────────────────────────────────────────────

  get_knowledge_graph: {
    description: "Full workspace knowledge graph: all projects, notes, cards, and tags as nodes with relationships as edges. Scope with projectIds to reduce size.",
    schema: z.object({
      workspaceId: sId,
      projectIds:  z.array(z.string()).optional(),
      includeAuto: sBoolOpt.describe("Include auto-discovered edges (co-mention, keyword, assignee). Default true."),
      nodeTypes:   z.array(z.enum(["project", "note", "card", "tag"])).optional(),
      edgeTypes:   z.array(z.string()).optional(),
    }),
  },

  get_neighbors: {
    description: "N-hop neighbourhood around a node in the knowledge graph. Prefer over get_knowledge_graph for focused research.",
    schema: z.object({
      workspaceId: sId,
      nodeId:      sId.describe("Note ID, card ID, project ID, or tag ID"),
      depth:       z.number().optional().describe("Hops (1–3, default 1)"),
      edgeTypes:   z.array(z.string()).optional(),
    }),
  },

  // ── Tags ──────────────────────────────────────────────────────────────────────

  create_tag: {
    description: "Create a workspace tag. Check get_active_context for existing tags first to avoid duplicates.",
    schema: z.object({
      workspaceId: sId,
      name:        sStr,
      color:       sColor,
    }),
  },

  // ── Interactive clarification (chat-only, renderer-handled) ─────────────────

  ask_questions: {
    description: "Present a structured list of clarifying questions to the user as an inline form. Each question gets its own labeled text input. The user fills in all answers and submits them together. Use this instead of asking questions in prose.",
    schema: z.object({
      questions: z.array(z.object({
        id:     z.string().describe("Short unique identifier, e.g. \"target_users\""),
        label:  z.string().describe("Short bold label shown above the input, e.g. \"Target users\""),
        prompt: z.string().describe("One-sentence question shown as placeholder text"),
      })).describe("2–4 targeted questions"),
    }),
  },

  suggest_connections: {
    description: "Emit a structured list of suggested connections for the Knowledge Graph Assistant panel. Call this AFTER writing your prose analysis to surface actionable items the user can apply with one click. Each action targets a specific node by its ID from the graph snapshot.",
    schema: z.object({
      actions: z.array(z.discriminatedUnion("type", [
        z.object({
          type:         z.literal("add_wikilink"),
          sourceNoteId: z.string().describe("ID of the note to insert the wikilink into"),
          sourceTitle:  z.string().describe("Title of the source note"),
          targetTitle:  z.string().describe("Title of the note to link to (becomes [[targetTitle]])"),
          reason:       z.string().describe("One sentence explaining why this link is valuable"),
        }),
        z.object({
          type:         z.literal("link_note_note"),
          sourceNoteId: z.string().describe("ID of the first note"),
          sourceTitle:  z.string().describe("Title of the first note"),
          targetNoteId: z.string().describe("ID of the second note"),
          targetTitle:  z.string().describe("Title of the second note"),
          reason:       z.string().describe("One sentence explaining why these notes should be linked"),
        }),
        z.object({
          type:      z.literal("link_note_card"),
          noteId:    z.string().describe("ID of the note"),
          noteTitle: z.string().describe("Title of the note"),
          cardId:    z.string().describe("ID of the task card"),
          cardTitle: z.string().describe("Title of the task card"),
          reason:    z.string().describe("One sentence explaining why this note-task link is valuable"),
        }),
        z.object({
          type:      z.literal("add_tag"),
          nodeId:    z.string().describe("ID of the note or card to tag"),
          nodeTitle: z.string().describe("Title of the note or card"),
          nodeType:  z.enum(["note", "card"]).describe("Whether the target is a note or a card"),
          tagName:   z.string().describe("Name of the tag to apply (will be created if it doesn't exist)"),
          reason:    z.string().describe("One sentence explaining why this tag is appropriate"),
        }),
      ])).describe("List of suggested connection actions, max 8"),
    }),
  },

} as const;

export type ToolName = keyof typeof TOOL_SCHEMAS;

// Chat-only tools (not exposed via MCP)
export const CHAT_ONLY_TOOLS: ToolName[] = ["get_active_context", "generate_prd", "spawn_tasks_from_note", "ask_questions", "suggest_connections"];

/**
 * Tools excluded only from in-app agents (chat + pi-agent) but kept in MCP.
 * External MCP clients (Claude Desktop, etc.) benefit from the broader surface.
 *
 *   get_cairn_context  → useful for fresh MCP sessions; agents use get_project_context_pack
 */
export const AGENT_EXCLUDED_TOOLS: ToolName[] = [
  "get_cairn_context",
];

export type ToolCategory = "read" | "write" | "delete";

function toolCategory(name: string): ToolCategory {
  if (name.startsWith("delete_")) return "delete";
  if (
    name.startsWith("get_") ||
    name.startsWith("list_") ||
    name.startsWith("search_") ||
    name.startsWith("resolve_")
  ) return "read";
  return "write";
}

// MCP tool list: name + category for every tool the MCP server advertises.
// Excludes chat-only tools. Imported by MCPSettings.tsx.
const _chatOnlySet = new Set<string>(CHAT_ONLY_TOOLS);
export const MCP_TOOLS: { name: string; category: ToolCategory }[] = Object.keys(TOOL_SCHEMAS)
  .filter((name) => !_chatOnlySet.has(name))
  .map((name) => ({ name, category: toolCategory(name) }));
