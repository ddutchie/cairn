/**
 * Cairn — AI tool definitions and system prompt builder
 *
 * Contains the OpenAI function-calling TOOLS array, TOOL_LABELS record,
 * and the buildSystemPrompt function. Shared by the chat IPC handler.
 */

import path from "path";

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
};

// Tool definitions for the AI (OpenAI function calling format)
export const TOOLS = [
  {
    type: "function",
    function: {
      name: "get_cairn_context",
      description: "Returns a full orientation guide for working with this Cairn instance: all workspaces, projects, board columns with IDs, available tools, and data conventions. Call this once at the start of any session if you are unfamiliar with the workspace.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "get_project_context_pack",
      description: "Single-call context bundle for a project: metadata, column IDs, pinned note content, open tasks (non-done only), and recent activity. Use instead of calling get_project_summary + list_tasks + list_notes separately when you need a full picture before acting.",
      parameters: {
        type: "object",
        properties: { projectId: { type: "string" } },
        required: ["projectId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "resolve_project",
      description: "Find a project by name (exact or fuzzy, case-insensitive) and return its projectId and column IDs. Use this instead of hardcoding IDs or calling get_cairn_context just to look up a project.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Project name to search for" },
          workspaceId: { type: "string", description: "Optionally scope to a specific workspace" },
        },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_active_context",
      description: "Returns the active workspace, project, all board columns with IDs, and recent notes and tasks. Call this first to get IDs needed for other tools.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "get_note",
      description: "Get the full content of a note by its ID.",
      parameters: {
        type: "object",
        properties: {
          noteId: { type: "string" },
        },
        required: ["noteId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_notes",
      description: "List all notes in a project. Use this to see what documents exist.",
      parameters: {
        type: "object",
        properties: {
          projectId: { type: "string", description: "Filter by project ID" },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_tasks",
      description: "List all tasks in a project, grouped by column.",
      parameters: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          columnType: { type: "string", enum: ["backlog", "todo", "in_progress", "review", "done"] },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_notes",
      description: "Search notes by query string.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          projectId: { type: "string" },
          limit: { type: "number", default: 10 },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_tasks",
      description: "Search task cards by query string.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          projectId: { type: "string" },
          columnType: { type: "string", enum: ["backlog", "todo", "in_progress", "review", "done"] },
          limit: { type: "number", default: 10 },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_project_summary",
      description: "Get a full summary of a project: card counts by column, notes, recent activity.",
      parameters: {
        type: "object",
        properties: { projectId: { type: "string" } },
        required: ["projectId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_note",
      description: "Create a new note in a project. Content is markdown.",
      parameters: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          title: { type: "string" },
          content: { type: "string" },
        },
        required: ["projectId", "title"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "import_note_from_file",
      description: "Import a local file (e.g. README.md) as a note by reading it from disk. Use this instead of create_note when the content already exists as a file — no need to inline large text in the tool call. title defaults to the filename without extension.",
      parameters: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          filePath: { type: "string", description: "Absolute path to the file to import" },
          title: { type: "string", description: "Override the note title (defaults to filename without extension)" },
        },
        required: ["projectId", "filePath"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ensure_note",
      description: "Idempotent create-or-update: finds an existing note by title+projectId and updates its content, or creates it if not found. Use instead of create_note when re-running (e.g. syncing a README) to prevent duplicates. Returns { id, title, action: 'created'|'updated' }.",
      parameters: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          title: { type: "string" },
          content: { type: "string" },
        },
        required: ["projectId", "title"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "append_to_note",
      description: "Append content to the end of an existing note without fetching or re-sending the full body. Useful for adding sections incrementally.",
      parameters: {
        type: "object",
        properties: {
          noteId: { type: "string" },
          content: { type: "string", description: "Text to append" },
          separator: { type: "string", description: "Inserted between existing and new content (default: blank line)" },
        },
        required: ["noteId", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "patch_note",
      description: "Surgically replace a specific string inside a note without re-sending the full content. Include enough surrounding context in oldString to make it unique. Returns an error if oldString is not found or matches multiple times (use replaceAll: true to replace all occurrences). Prefer this over update_note when editing part of a large note.",
      parameters: {
        type: "object",
        properties: {
          noteId: { type: "string" },
          oldString: { type: "string", description: "Exact string to find in the note — include enough context to be unique" },
          newString: { type: "string", description: "Replacement string" },
          replaceAll: { type: "boolean", description: "Replace all occurrences instead of requiring uniqueness (default: false)" },
        },
        required: ["noteId", "oldString", "newString"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_note",
      description: "Update a note's title, content, or pinned state. All fields except noteId are optional.",
      parameters: {
        type: "object",
        properties: {
          noteId:   { type: "string" },
          title:    { type: "string" },
          content:  { type: "string", description: "Full markdown content" },
          isPinned: { type: "boolean", description: "Pin or unpin the note in the project overview" },
        },
        required: ["noteId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_task",
      description: "Create a task card in a board column.",
      parameters: {
        type: "object",
        properties: {
          columnId: { type: "string" },
          projectId: { type: "string" },
          title: { type: "string" },
          description: { type: "string" },
          priority: { type: "string", enum: ["low", "medium", "high", "urgent"] },
        },
        required: ["columnId", "projectId", "title"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_task_status",
      description: "Move a single task card to a different column.",
      parameters: {
        type: "object",
        properties: {
          cardId: { type: "string" },
          targetColumnId: { type: "string" },
        },
        required: ["cardId", "targetColumnId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "bulk_update_task_status",
      description: "Move multiple task cards to the same target column in a single call. Use this instead of calling update_task_status repeatedly when moving more than one task.",
      parameters: {
        type: "object",
        properties: {
          cardIds: {
            type: "array",
            items: { type: "string" },
            description: "IDs of the task cards to move.",
          },
          targetColumnId: { type: "string", description: "The column to move all cards to." },
        },
        required: ["cardIds", "targetColumnId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_project",
      description: "Create a new project in a workspace, including default board columns (Backlog, Todo, In Progress, Review, Done). Call get_active_context first to get the workspaceId.",
      parameters: {
        type: "object",
        properties: {
          workspaceId: { type: "string" },
          name: { type: "string" },
          description: { type: "string" },
          icon: { type: "string", description: "A single emoji" },
          status: { type: "string", enum: ["active", "on_hold", "completed", "archived"] },
          priority: { type: "string", enum: ["low", "medium", "high", "urgent"] },
        },
        required: ["workspaceId", "name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_project",
      description: "Update a project's name, description, icon, status, priority, or due date.",
      parameters: {
        type: "object",
        properties: {
          projectId:   { type: "string" },
          name:        { type: "string" },
          description: { type: "string" },
          icon:        { type: "string", description: "A single emoji" },
          status:      { type: "string", enum: ["active", "on_hold", "completed", "archived"] },
          priority:    { type: "string", enum: ["low", "medium", "high", "urgent"] },
          dueDate:     { type: "string", description: "ISO 8601 date string, or empty string to clear" },
        },
        required: ["projectId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_project",
      description: "Permanently delete a project and all its notes, tasks, and columns. Use with caution — this cannot be undone.",
      parameters: {
        type: "object",
        properties: {
          projectId: { type: "string" },
        },
        required: ["projectId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_recent_activity",
      description: "List recently created or updated notes and tasks in a workspace, sorted by updated_at descending.",
      parameters: {
        type: "object",
        properties: {
          workspaceId: { type: "string" },
          projectId:   { type: "string", description: "Optional — filter to a specific project" },
          limit:       { type: "number", description: "Max items to return (default 20)" },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_task",
      description: "Get full detail of a task card by its ID — title, description, priority, dueDate, column, linked notes.",
      parameters: {
        type: "object",
        properties: {
          cardId: { type: "string" },
        },
        required: ["cardId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_note",
      description: "Permanently delete a note by its ID. Use with caution — this cannot be undone.",
      parameters: {
        type: "object",
        properties: {
          noteId: { type: "string" },
        },
        required: ["noteId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_task",
      description: "Permanently delete a task card by its ID. Use with caution — this cannot be undone.",
      parameters: {
        type: "object",
        properties: {
          cardId: { type: "string" },
        },
        required: ["cardId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_dashboard",
      description: "Create a live HTML dashboard in a project. The dashboard renders in a sandboxed iframe inside Cairn. The html must be a complete self-contained HTML document using inline CSS/JS only. Use window.cairn.query(tool, args) in JS to fetch live data — never bake in static values.",
      parameters: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          title: { type: "string" },
          html: { type: "string", description: "Complete self-contained HTML document with inline CSS/JS. Use window.cairn.query() for live data." },
        },
        required: ["projectId", "title", "html"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_dashboard",
      description: "Update an existing dashboard's title or HTML. Pass the noteId of the dashboard note.",
      parameters: {
        type: "object",
        properties: {
          noteId: { type: "string", description: "The dashboard note ID" },
          title: { type: "string" },
          html: { type: "string", description: "Updated complete self-contained HTML document" },
        },
        required: ["noteId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "generate_prd",
      description: "Generate a structured Product Requirements Document (PRD) from a plain-language description and save it as a note in the project. Returns the created note with its ID.",
      parameters: {
        type: "object",
        properties: {
          projectId: { type: "string", description: "ID of the project to save the PRD note in" },
          title: { type: "string", description: "Title for the PRD note, e.g. 'PRD — Login System'" },
          requirements: { type: "string", description: "Plain-language description of what the user wants to build" },
        },
        required: ["projectId", "title", "requirements"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "spawn_tasks_from_note",
      description: "Read a PRD or spec note and create structured task cards on the board from it. Links the tasks back to the note bidirectionally. Returns the list of created tasks.",
      parameters: {
        type: "object",
        properties: {
          noteId: { type: "string", description: "ID of the note to generate tasks from" },
          columnId: { type: "string", description: "Column to place the tasks in (use Backlog by default)" },
        },
        required: ["noteId", "columnId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_task",
      description: "Update a task card's fields. All fields except cardId are optional — only provided fields are changed. (Parameter was previously named taskId.)",
      parameters: {
        type: "object",
        properties: {
          cardId:      { type: "string", description: "ID of the task card to update" },
          title:       { type: "string" },
          description: { type: "string" },
          priority:    { type: "string", enum: ["low", "medium", "high", "urgent"] },
          dueDate:     { type: "string", description: "ISO date string e.g. 2026-05-01, or empty string to clear" },
          columnId:    { type: "string", description: "Move to this column ID" },
          assignee:    { type: "string", description: "Assignee name, or empty string to clear" },
        },
        required: ["cardId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "move_note",
      description: "Move a note to a different project. Updates the note's projectId, moves its .md file to the new project folder, and re-links any linked tasks.",
      parameters: {
        type: "object",
        properties: {
          noteId:           { type: "string" },
          targetProjectId:  { type: "string", description: "ID of the destination project" },
        },
        required: ["noteId", "targetProjectId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "link_note_to_task",
      description: "Bidirectionally link a note and a task card. The note gains the card in linkedCardIds, the card gains the note in linkedNoteIds.",
      parameters: {
        type: "object",
        properties: {
          noteId: { type: "string" },
          cardId: { type: "string" },
        },
        required: ["noteId", "cardId"],
      },
    },
  },
  // ── Idea Flow ──────────────────────────────────────────────────────────────
  {
    type: "function",
    function: {
      name: "get_idea_flow",
      description: "Get the full Idea Flow graph for a project: all nodes (with resolved note/task content) and edges. Call this before making changes to understand the current canvas state.",
      parameters: {
        type: "object",
        properties: {
          projectId: { type: "string" },
        },
        required: ["projectId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_idea_flow_node",
      description: "Add a new node to a project's Idea Flow canvas. Node types: idea (title+body), note_ref (noteId), task_ref (cardId), group (label+color), url (url+title+description), ai_summary (content).",
      parameters: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          type:      { type: "string", enum: ["idea", "note_ref", "task_ref", "group", "url", "ai_summary"] },
          x:         { type: "number", description: "Canvas X position" },
          y:         { type: "number", description: "Canvas Y position" },
          width:     { type: "number", description: "Optional node width" },
          height:    { type: "number", description: "Optional node height" },
          parentId:  { type: "string", description: "Optional parent group node ID" },
          data:      { type: "object", description: "Node data: idea={title,body}, note_ref={noteId}, task_ref={cardId}, group={label,color}, url={url,title,description}, ai_summary={content}" },
        },
        required: ["projectId", "type"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_idea_flow_node",
      description: "Update a node's data and/or position in the Idea Flow. Only provided fields are changed; data fields are merged (not replaced).",
      parameters: {
        type: "object",
        properties: {
          nodeId: { type: "string" },
          x:      { type: "number", description: "New X position" },
          y:      { type: "number", description: "New Y position" },
          width:  { type: "number" },
          height: { type: "number" },
          data:   { type: "object", description: "Partial data to merge into the node's existing data" },
        },
        required: ["nodeId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_idea_flow_node",
      description: "Remove a node from the Idea Flow. Also removes all edges connected to that node.",
      parameters: {
        type: "object",
        properties: {
          nodeId: { type: "string" },
        },
        required: ["nodeId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_idea_flow_edge",
      description: "Connect two nodes in the Idea Flow with an optional label.",
      parameters: {
        type: "object",
        properties: {
          sourceNodeId: { type: "string", description: "ID of the source node" },
          targetNodeId: { type: "string", description: "ID of the target node" },
          label:        { type: "string", description: "Optional label for the connection" },
        },
        required: ["sourceNodeId", "targetNodeId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_idea_flow_edge",
      description: "Remove a connection between two nodes in the Idea Flow.",
      parameters: {
        type: "object",
        properties: {
          edgeId: { type: "string" },
        },
        required: ["edgeId"],
      },
    },
  },
];

export interface ChatRequest {
  message: string;
  threadId: string;
  projectId?: string;
  workspaceId?: string;
  history?: Array<{ role: "user" | "assistant" | "system"; content: string }>;
  config?: { baseUrl?: string; model?: string; apiKey?: string };
}

export function buildSystemPrompt(req: ChatRequest): string {
  return `You are the Cairn AI assistant — an intelligent helper embedded inside a note-taking and project management app.

## How to get context
Call \`get_active_context\` first whenever you need IDs (projectId, columnId, workspaceId, noteId). It returns live data directly from the database. Never ask the user for IDs.
If you are unfamiliar with this workspace or need a full tool/convention reference, call \`get_cairn_context\` once.

## Instructions
- Always call \`get_active_context\` before any write operation or when you need IDs
- For write operations (create note, create task, move card) call the tool directly — no need to ask for confirmation
- After a write succeeds, briefly confirm what you did
- Use **bold** for key items, bullet lists for multiple items
- Keep responses concise and actionable

## Dashboards
You can create interactive HTML dashboards that render live inside Cairn using \`create_dashboard\`.
- The \`html\` field must be a complete, self-contained HTML document with inline CSS and JS only — no external URLs
- Dashboards have access to \`window.cairn.query(tool, args)\` which returns a Promise with live data from the DB
- Available query tools: get_cairn_context, get_project_summary, list_tasks, list_notes, list_recent_activity, search_tasks, search_notes
- Always fetch data dynamically via \`window.cairn.query()\` rather than baking in static data — this keeps dashboards live
- Call \`update_dashboard\` to update an existing dashboard's HTML (pass the noteId)
- Dashboards appear in the Notes panel with a grid icon

Always use the typed helpers — never call window.cairn.query() directly:

  window.cairn.projectId      - active project ID (already set, do not hardcode)
  window.cairn.workspaceId    - active workspace ID (already set, do not hardcode)
  window.cairn.getProjectSummary(projectId)   -- projectId optional, defaults to active
    returns: { project, noteCount, totalCards, columns: [{ id, name, type, taskCount, tasks: [{ id, title, priority, dueDate }] }] }
  window.cairn.listTasks(projectId)           -- projectId optional, defaults to active
    returns: { tasksByColumn: { COLUMN_ID: [{ id, title, priority, description, dueDate, columnId, columnName, columnType, updatedAt }] } }
    usage:   const allCards = Object.values(result.tasksByColumn).flat();
  window.cairn.listNotes(projectId)           -- projectId optional, defaults to active
    returns: [{ id, title, projectId, isPinned, updatedAt }]
  window.cairn.listRecentActivity(opts)       -- opts optional, defaults to active workspace+project
    returns: { recentNotes: [{ id, title, projectId, updatedAt }], recentTasks: [{ id, title, projectId, updatedAt }] }
  window.cairn.searchTasks(query, projectId)  -- projectId optional
    returns: [{ id, title, priority, columnId }]
  window.cairn.searchNotes(query, projectId)  -- projectId optional
    returns: [{ id, title, snippet, projectId }]
  window.cairn.getContext()
    returns: { workspaces, projects: [{ id, name, status, priority, columns: [{ id, name, type }] }] }

Never hardcode projectId or workspaceId — always use window.cairn.projectId and window.cairn.workspaceId.

## Idea Flow
Each project has a node-based canvas (Idea Flow) for visually structuring ideas.
- Call \`get_idea_flow\` to read the current canvas — returns nodes (with resolved note/task content) and edges
- Use \`create_idea_flow_node\` to add nodes: idea, note_ref, task_ref, group, url, or ai_summary
- Use \`create_idea_flow_edge\` to connect nodes (sourceNodeId → targetNodeId, optional label)
- Use \`update_idea_flow_node\` / \`delete_idea_flow_node\` / \`delete_idea_flow_edge\` to modify the graph
- When creating an ai_summary node, set data.content to your synthesised text — the UI shows it as read-only

Tone: calm, focused, like a thoughtful co-worker.`;
}
