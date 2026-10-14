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
const sTagNames    = z.array(z.string()).optional().describe("Tag names to automatically resolve or create");
const sPriority    = z.enum(["low", "medium", "high", "urgent"]).optional();
const sStatus      = z.enum(["active", "on_hold", "completed", "archived"]).optional();
const sColType     = z.enum(["backlog", "todo", "in_progress", "review", "done"]).optional();
const sDueDate     = z.string().optional().describe("ISO date e.g. 2026-05-01, or empty to clear");

// ── Tool schema map ────────────────────────────────────────────────────────────
// Each entry: { description, schema (Zod object shape for McpServer.tool) }.
// Consolidated toolset (v3.1.3): one tool per intent, with mode/filter/action
// enums instead of near-duplicate tools. The executors translate these onto the
// per-operation handlers in electron/mcp/tools/* (see mcp/tools/consolidated.ts).

const sTagMode    = z.enum(["add", "remove", "set"]).optional().describe("How tagNames apply: add (default), remove, or set (replace all)");
const sIdList     = z.array(z.string());

export const TOOL_SCHEMAS = {

  // ── Context & reads ──────────────────────────────────────────────────────────

  get_context: {
    description: "Orientation: workspace, projects, board columns, tags, conventions. With projectId: that project's pinned notes, folders, templates, open tasks and recent activity. Call first to get IDs.",
    schema: z.object({ projectId: sIdOpt }),
  },

  get_item: {
    description: "Full content of a note or task card by id (type is detected from the id).",
    schema: z.object({ id: sId }),
  },

  search_notes: {
    description: "Find notes. mode 'keyword' (default) matches words in title/body; 'semantic' finds related meaning via local embeddings. Empty query lists notes, newest first. type 'template' lists note templates.",
    schema: z.object({
      query:        sStr,
      mode:         z.enum(["keyword", "semantic"]).optional(),
      projectId:    sIdOpt,
      folder:       sStrOpt.describe("Only notes in this folder"),
      tag:          sStrOpt.describe("Only notes with this tag name"),
      type:         z.enum(["note", "template"]).optional(),
      updatedAfter: z.iso.datetime({ offset: true }).optional().describe("ISO datetime; only notes updated after it"),
      limit:        z.number().optional().default(10),
      offset:       z.number().int().nonnegative().optional().default(0).describe("Pagination offset (default 0)"),
    }),
  },

  search_tasks: {
    description: "Find task cards. mode 'keyword' (default) or 'semantic'. filter: 'ready' (unblocked, not done), 'overdue', or 'due' (due within dueWithinDays, default 7, including overdue). Empty query lists all matching.",
    schema: z.object({
      query:         sStr,
      mode:          z.enum(["keyword", "semantic"]).optional(),
      projectId:     sIdOpt,
      columnType:    sColType,
      filter:        z.enum(["ready", "overdue", "due"]).optional(),
      dueWithinDays: z.number().int().min(0).optional(),
      assignee:      sStrOpt,
      tag:           sStrOpt.describe("Only cards with this tag name"),
      limit:         z.number().optional().default(10),
    }),
  },

  // ── Notes ────────────────────────────────────────────────────────────────────

  ensure_note: {
    description: "Create-or-update a note by title+projectId (idempotent). Omitted content is preserved on update; a drastic shrink is rejected unless overwrite:true. templateId creates the note from a template (search_notes type:'template'), filling date/title placeholders.",
    schema: z.object({
      projectId:  sId,
      title:      sStr,
      content:    sStrOpt.describe("Markdown"),
      templateId: sIdOpt,
      folder:     sStrOpt.describe("Subfolder path; empty = project root"),
      tagNames:   sTagNames,
      isPinned:   sBoolOpt,
      overwrite:  sBoolOpt.describe("Allow replacing content with much shorter content"),
    }),
  },

  edit_note: {
    description: "Edit a note's text. With oldString: replace that exact text (include surrounding context so it is unique). Without oldString: append newString to the end.",
    schema: z.object({
      noteId:     sId,
      newString:  sStr,
      oldString:  sStrOpt,
      replaceAll: sBoolOpt,
    }),
  },

  update_notes: {
    description: "Change one or more notes: rename (updates incoming [[wikilinks]]), move to a folder, tag, pin, or link/unlink task cards.",
    schema: z.object({
      noteIds:       sIdList,
      title:         sStrOpt.describe("New title (single note only)"),
      folder:        sStrOpt.describe("Move to this folder; empty = project root"),
      tagNames:      sTagNames,
      tagMode:       sTagMode,
      isPinned:      sBoolOpt,
      linkCardIds:   sIdList.optional().describe("Card ids to link to these notes"),
      unlinkCardIds: sIdList.optional().describe("Card ids to unlink from these notes"),
    }),
  },

  // ── Tasks ─────────────────────────────────────────────────────────────────────

  create_task: {
    description: "Create a task card. Place it with columnType (default backlog) or an explicit columnId.",
    schema: z.object({
      projectId:   sId,
      title:       sStr,
      description: sStrOpt,
      columnType:  sColType,
      columnId:    sIdOpt,
      priority:    sPriority,
      dueDate:     sDueDate,
      tagNames:    sTagNames,
      linkNoteIds: sIdList.optional().describe("Notes to link to the new card"),
    }),
  },

  update_tasks: {
    description: "Update one or more task cards; only provided fields change. Move with columnType or columnId (moving to done unblocks dependents). Also tags, links to notes, blockers, archive/restore.",
    schema: z.object({
      cardIds:       sIdList,
      title:         sStrOpt,
      description:   sStrOpt,
      priority:      sPriority,
      dueDate:       sDueDate,
      columnType:    sColType,
      columnId:      sIdOpt,
      assignee:      sStrOpt.describe("Assignee name, or empty to clear"),
      archived:      sBoolOpt.describe("true = archive, false = restore"),
      tagNames:      sTagNames,
      tagMode:       sTagMode,
      linkNoteIds:   sIdList.optional().describe("Note ids to link to these cards"),
      unlinkNoteIds: sIdList.optional().describe("Note ids to unlink from these cards"),
      blockedBy:     sIdList.optional().describe("Cards that block these (same project; circular deps rejected)"),
      unblockFrom:   sIdList.optional().describe("Blockers to remove"),
    }),
  },

  task_progress: {
    description: "Agent work log on a card. 'claim': set the assignee to your agent label and move Backlog/To Do cards to In Progress (refuses if another agent holds it unless force). 'log': append a one-line update under '## Progress'; moveTo review/done when finished.",
    schema: z.object({
      cardId:  sId,
      action:  z.enum(["claim", "log"]),
      agent:   sStrOpt.describe("Who is working, e.g. \"Claude Code\""),
      message: sStrOpt.describe("For log: what changed, what's next, or what's blocking"),
      moveTo:  z.enum(["in_progress", "review", "done"]).optional(),
      force:   sBoolOpt.describe("Take over a card claimed by someone else"),
    }),
  },

  // ── Projects & delete ─────────────────────────────────────────────────────────

  upsert_project: {
    description: "Create or update a project. Omit projectId to create (auto-creates default columns); provide projectId to update existing fields.",
    schema: z.object({
      projectId:   sIdOpt.describe("Omit to create a new project"),
      workspaceId: sId.optional().describe("Required when creating"),
      name:        sStrOpt.describe("Required when creating"),
      description: sStrOpt,
      icon:        sStrOpt.describe("Single emoji"),
      status:      sStatus,
      priority:    sPriority,
    }),
  },

  delete: {
    description: "Permanently delete a note, task card, project (with all its contents), idea-flow node, or idea-flow edge. Cannot be undone.",
    schema: z.object({
      type: z.enum(["note", "task", "project", "flow_node", "flow_edge"]),
      id:   sId,
    }),
  },

  // ── Idea Flow ─────────────────────────────────────────────────────────────────

  get_idea_flow: {
    description: "Get the Idea Flow graph: nodes (with note/task content), edges, spatial bounds, and nextPosition. Call before making changes.",
    schema: z.object({ projectId: sId }),
  },

  edit_idea_flow: {
    description: "Apply Idea Flow ops in order, then optionally auto-layout. ops: add_node {type, data, x?, y?, parentId?, ref?} — types: idea {title, body}, note_ref {noteId | noteTitle, noteContent?}, task_ref {cardId | taskTitle, taskDescription?}, url {url, title?}, ai_summary {content}, group {label?, color?}; update_node {nodeId, data?, x?, y?} (data is merged); add_edge {source, target, label?}; delete_node {nodeId}; delete_edge {edgeId}. Any nodeId/parentId/source/target may name an earlier op's ref. Place new nodes from get_idea_flow's spatial.nextPosition; child x/y are relative to their group. Don't connect edges to groups.",
    schema: z.object({
      projectId: sId,
      ops:       z.array(z.object({ op: z.enum(["add_node", "update_node", "add_edge", "delete_node", "delete_edge"]) }).passthrough()),
      layout:    z.enum(["LR", "TB"]).optional().describe("Auto-arrange afterwards (LR or TB)"),
    }),
  },

  // ── Knowledge graph ───────────────────────────────────────────────────────────

  get_graph: {
    description: "Knowledge graph. With nodeId (note, card, project or tag id): its N-hop neighbourhood (depth 1–3, default 1); semantic:true instead returns notes similar in meaning. Without nodeId: the whole workspace graph — scope with projectIds.",
    schema: z.object({
      nodeId:      sIdOpt,
      depth:       z.number().optional(),
      semantic:    sBoolOpt,
      projectIds:  sIdList.optional(),
      nodeTypes:   z.array(z.enum(["project", "note", "card", "tag"])).optional(),
      edgeTypes:   z.array(z.string()).optional(),
      includeAuto: sBoolOpt.describe("Include auto-discovered edges (co-mention, keyword, assignee). Default true."),
    }),
  },

  // ── Writing style ─────────────────────────────────────────────────────────────

  get_user_writing_style: {
    description: "Return the user's personal writing style — their persona plus a style guide to match when drafting or rewriting content IN the user's voice (emails, notes, PRDs, replies). Prefer the condensed 'cheatsheet' for everyday drafting; request 'full' for long-form work or deep analysis. Returns configured:false when the user hasn't set one up — never invent a style.",
    schema: z.object({
      mode: z.enum(["cheatsheet", "full"]).optional().describe("'cheatsheet' (default) = condensed one-page reference; 'full' = the complete style guide"),
    }),
  },
  update_user_writing_style: {
    description: "Append an observation to the user's writing style guide. Only when the user asks you to remember a style preference, or you notice a consistent correction — never invent one. Call get_user_writing_style first to avoid duplicates.",
    schema: z.object({
      section: z.string().optional().describe("Guide section by number or heading: 1 Voice, 2 Sentence Length & Rhythm, 3 Tone & Register, 4 Openings & Closings, 5 Punctuation, 6 Vocabulary & Phrases, 7 Feedback & Disagreement, 8 Emoji, 9 Formatting, 10 Other Patterns, 11 Anti-Patterns, 12 Voice Tells. Omit to append at the end."),
      content: z.string().min(1).describe("Concise style rule, e.g. 'Prefers plain hyphens over em-dashes'"),
    }),
  },

  // ── Codebase index (coding + MCP; not chat) ───────────────────────────────────

  codebase_reindex: {
    description: "Scan and semantic-index a codebase folder. Updates the SQLite cache of file paths, classes, functions, methods, docstrings, and call dependencies. Unchanged files are skipped via a content hash; pass force:true to drop the cache and re-parse everything.",
    schema: z.object({
      folder: sStr.describe("Absolute path to the codebase root folder"),
      force:  z.boolean().optional().describe("Re-parse every file even if unchanged (rebuild the index)."),
    }),
  },

  codebase_query: {
    description: "Query the codebase index. action 'search': symbols (classes, functions, methods…) by name or docstring; 'definition': a symbol's signature, lines and docstring; 'references': its callers and callees; 'file': every symbol in a file.",
    schema: z.object({
      action: z.enum(["search", "definition", "references", "file"]),
      query:  sStr.describe("Search text, exact symbol name, or absolute file path (for 'file')"),
      folder: sStrOpt.describe("Absolute path to limit scope"),
      limit:  sNumOpt.describe("Max matches for 'search' (default 50)"),
    }),
  },

  // ── Chat-only ────────────────────────────────────────────────────────────────

  ask_questions: {
    description: "Present a structured list of clarifying questions to the user as an inline form. Each question gets its own labeled text input. The user fills in all answers and submits them together. Use this instead of asking questions in prose.",
    schema: z.object({
      questions: z.array(z.object({
        id:     z.string().describe("Short unique identifier, e.g. \"target_users\""),
        label:  z.string().describe("Short bold label shown above the input, e.g. \"Target users\""),
        prompt: z.string().describe("One-sentence question shown above the answer field, e.g. \"Who is this for?\""),
      })).describe("2–4 targeted questions"),
    }),
  },
  suggest_connections: {
    description: "Emit a structured list of suggested connections for the Knowledge Graph Assistant panel. Call this AFTER writing your prose analysis to surface actionable items the user can apply with one click. Each action targets a specific node by its ID from the graph snapshot.",
    schema: z.object({
      actions: z.array(z.object({
        type: z.enum(["add_wikilink", "link_note_note", "link_note_card", "add_tag"]).describe("Type of connection action to suggest"),
        reason: z.string().describe("One sentence explaining why this connection is valuable"),

        // wikilink & note-to-note fields
        sourceNoteId: z.string().optional().describe("ID of the note to insert the wikilink into / first note"),
        sourceTitle:  z.string().optional().describe("Title of the source/first note"),
        targetTitle:  z.string().optional().describe("Title of the note to link to (becomes [[targetTitle]]) / second note"),

        // note-to-note field
        targetNoteId: z.string().optional().describe("ID of the second note"),

        // note-to-task fields
        noteId:    z.string().optional().describe("ID of the note"),
        noteTitle: z.string().optional().describe("Title of the note"),
        cardId:    z.string().optional().describe("ID of the task card"),
        cardTitle: z.string().optional().describe("Title of the task card"),

        // tag fields
        nodeId:    z.string().optional().describe("ID of the note or card to tag"),
        nodeTitle: z.string().optional().describe("Title of the note or card"),
        nodeType:  z.enum(["note", "card"]).optional().describe("Whether the target is a note or a card"),
        tagName:   z.string().optional().describe("Name of the tag to apply (will be created if it doesn't exist)"),
      })).describe("List of suggested connection actions, max 8"),
    }),
  },
  spawn_tasks_from_note: {
    description: "Read a PRD/spec note and create task cards from it. Links tasks to the note.",
    schema: z.object({
      noteId:   sId,
      columnId: sId.describe("Column for new tasks (Backlog by default)"),
    }),
  },

} as const;

export type ToolName = keyof typeof TOOL_SCHEMAS;

/**
 * Tools the in-app chat does not register. Chat has no filesystem access, and
 * the codebase symbol index is a coding-agent / external-agent tool: sending
 * these schemas on every chat turn cost ~540 tokens for tools chat never uses.
 * Coding sessions and MCP still get them.
 */
export const CHAT_EXCLUDED_TOOLS: ToolName[] = [
  "codebase_reindex",
  "codebase_query",
];

// Chat-only tools (not exposed via MCP)
export const CHAT_ONLY_TOOLS: ToolName[] = ["spawn_tasks_from_note", "ask_questions", "suggest_connections"];

export type ToolCategory = "read" | "write" | "delete";

export function toolCategory(name: string): ToolCategory {
  if (name === "delete" || name.startsWith("delete_")) return "delete";
  if (
    // codebase_query is read-only (READ in shared/agent/tool-risk.ts) but
    // matches no get_/list_/search_ prefix — name it explicitly so the MCP
    // inventory doesn't mislabel it as a write tool.
    name === "codebase_query" ||
    name.startsWith("get_") ||
    name.startsWith("list_") ||
    name.startsWith("search_")
  ) return "read";
  return "write";
}

// MCP tool list: name + category for every tool the MCP server advertises.
// Excludes chat-only tools. Imported by MCPSettings.tsx.
const _chatOnlySet = new Set<string>(CHAT_ONLY_TOOLS);
export const MCP_TOOLS: { name: string; category: ToolCategory }[] = Object.keys(TOOL_SCHEMAS)
  .filter((name) => !_chatOnlySet.has(name))
  .map((name) => ({ name, category: toolCategory(name) }));

/**
 * JSON Schema for a tool's parameters as sent to the model (chat `TOOLS` and the
 * MCP `tools/list` response). Drops keywords that cost tokens on every request
 * but carry no signal for the model (zod still validates server-side).
 * Validated by electron/lib/tool-schema-optimization.test.ts to preserve tool
 * selection and argument correctness:
 *   - `$schema`  — the draft-07 header
 *   - `pattern`  — e.g. the ~230-tok ISO-8601 regex on datetime fields
 *   - `minimum` / `maximum` — numeric bounds (esp. the 9e15 integer ceiling)
 *   - `default`  — informational only, not an instruction
 *   - `additionalProperties: false` — verbose; models don't rely on it
 * Field `description` text is deliberately KEPT (it drives arg correctness).
 */
export function toolParametersJsonSchema(schema: z.ZodType): Record<string, unknown> {
  // io:"input" — describe what the CALLER sends: fields with a zod `.default()`
  // stay optional (the default "output" view marks them required, which forced
  // models to always pass e.g. search_notes limit/offset).
  const json = z.toJSONSchema(schema, { target: "draft-07", io: "input" }) as Record<string, unknown>;
  delete json["$schema"];
  return stripSchemaNoise(json) as Record<string, unknown>;
}

function stripSchemaNoise(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(stripSchemaNoise);
  if (!node || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === "pattern" || k === "minimum" || k === "maximum" || k === "default") continue;
    if (k === "additionalProperties" && v === false) continue;
    out[k] = stripSchemaNoise(v);
  }
  return out;
}
