/**
 * Cairn — AI tool definitions and system prompt builder
 *
 * Contains the OpenAI function-calling TOOLS array, TOOL_LABELS record,
 * and the buildSystemPrompt function. Shared by the chat IPC handler.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ToolArgs = Record<string, any>;

// Human-readable labels for each tool call, shown in the UI
export const TOOL_LABELS: Record<string, (args: ToolArgs) => string> = {
  get_cairn_context:      () => "Reading workspace context",
  get_active_context:     () => "Reading active context",
  get_note:               () => `Reading note`,
  list_notes:             () => "Listing notes",
  list_tasks:             () => "Listing tasks",
  search_notes:           (a) => `Searching notes for "${a.query}"`,
  search_tasks:           (a) => `Searching tasks for "${a.query}"`,
  get_project_summary:    () => "Reading project summary",
  get_task:               () => "Reading task",
  create_note:            (a) => `Creating note "${a.title}"`,
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
      name: "update_note",
      description: "Update a note's title or content (markdown).",
      parameters: {
        type: "object",
        properties: {
          noteId: { type: "string" },
          title: { type: "string" },
          content: { type: "string" },
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

Tone: calm, focused, like a thoughtful co-worker.`;
}
