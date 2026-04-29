/**
 * Cairn — AI Chat IPC handler
 *
 * Runs the OpenAI-compatible completions loop in the Electron main process
 * so it works in the packaged app (no Next.js server needed).
 *
 * Registered as: ipcMain.handle("chat:send", ...)
 */

import { ipcMain } from "electron";
import type Database from "better-sqlite3";
import * as q from "../db/queries";
import { writeNoteFile, deleteNoteFile, stripMarkdown } from "../notes-files";

interface ChatRequest {
  message: string;
  threadId: string;
  projectId?: string;
  workspaceId?: string;
  history?: Array<{ role: "user" | "assistant" | "system"; content: string }>;
  config?: { baseUrl?: string; model?: string; apiKey?: string };
}

type OpenAIMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
};

function buildSystemPrompt(req: ChatRequest): string {
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

Example usage in dashboard JS:
  const summary = await window.cairn.query('get_project_summary', { projectId: 'abc' });
  const tasks = await window.cairn.query('list_tasks', { projectId: 'abc' });

Tone: calm, focused, like a thoughtful co-worker.\`;
}

// Tool definitions for the AI (OpenAI function calling format)
const TOOLS = [
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
      description: "Move a task card to a different column.",
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
      description: "Update a task card's fields. All fields except taskId are optional — only provided fields are changed.",
      parameters: {
        type: "object",
        properties: {
          taskId:      { type: "string", description: "ID of the task card to update" },
          title:       { type: "string" },
          description: { type: "string" },
          priority:    { type: "string", enum: ["low", "medium", "high", "urgent"] },
          dueDate:     { type: "string", description: "ISO date string e.g. 2026-05-01, or empty string to clear" },
          columnId:    { type: "string", description: "Move to this column ID" },
          assignee:    { type: "string", description: "Assignee name, or empty string to clear" },
        },
        required: ["taskId"],
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

export interface LLMConfig { baseUrl: string; model: string; apiKey: string; }

export async function callLLM(config: LLMConfig, systemPrompt: string, userPrompt: string): Promise<string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (config.apiKey) headers["Authorization"] = `Bearer ${config.apiKey}`;
  const response = await fetch(`${config.baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: config.model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      max_tokens: 4096,
      temperature: 0.4,
    }),
  });
  if (!response.ok) throw new Error(`LLM error ${response.status}: ${await response.text().catch(() => response.statusText)}`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data = await response.json() as any;
  return (data.choices?.[0]?.message?.content as string) ?? "";
}

// Human-readable labels for each tool call, shown in the UI
const TOOL_LABELS: Record<string, (args: Record<string, unknown>) => string> = {
  get_cairn_context:      () => "Reading workspace context",
  get_active_context:     () => "Reading active context",
  get_note:               (a) => `Reading note`,
  list_notes:             () => "Listing notes",
  list_tasks:             () => "Listing tasks",
  search_notes:           (a) => `Searching notes for "${a.query}"`,
  search_tasks:           (a) => `Searching tasks for "${a.query}"`,
  get_project_summary:    () => "Reading project summary",
  get_task:               () => "Reading task",
  create_note:            (a) => `Creating note "${a.title}"`,
  update_note:            () => "Updating note",
  create_task:            (a) => `Creating task "${a.title}"`,
  update_task_status:     () => "Moving task",
  update_task:            () => "Updating task",
  create_project:         (a) => `Creating project "${a.name}"`,
  delete_note:            () => "Deleting note",
  delete_task:            () => "Deleting task",
  generate_prd:           (a) => `Generating PRD "${a.title}"`,
  spawn_tasks_from_note:  () => "Spawning tasks from note",
  link_note_to_task:      () => "Linking note to task",
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function executeTool(db: Database.Database, req: ChatRequest, workspacePath: string, llmConfig: LLMConfig, name: string, args: Record<string, any>, emit?: (event: { tool: string; label: string; args: Record<string, unknown> }) => void): Promise<unknown> {
  emit?.({ tool: name, label: TOOL_LABELS[name]?.(args) ?? name, args });
  const snap = q.getFullSnapshot(db);
  const now = new Date().toISOString();
  const newId = () => Math.random().toString(36).slice(2, 14);

  switch (name) {
    case "get_cairn_context": {
      const workspaces = snap.workspaces.map((w) => ({ id: w.id, name: w.name }));
      const projects = snap.projects
        .filter((p) => !p.archivedAt)
        .map((p) => ({
          id: p.id, name: p.name, status: p.status, priority: p.priority,
          workspaceId: p.workspaceId,
          columns: snap.columns
            .filter((c) => c.projectId === p.id)
            .sort((a, b) => a.order - b.order)
            .map((c) => ({ id: c.id, name: c.name, type: c.type })),
        }));
      return {
        workspaces,
        projects,
        tools: {
          read:   ["get_cairn_context", "get_active_context", "get_note", "get_task", "list_notes", "list_tasks", "search_notes", "search_tasks", "get_project_summary"],
          write:  ["create_project", "create_note", "update_note", "create_task", "update_task", "update_task_status", "link_note_to_task", "create_dashboard", "update_dashboard"],
          delete: ["delete_note", "delete_task"],
        },
        conventions: {
          notes: "Raw markdown in 'content'. 'content_text' is auto-derived — do not set manually.",
          dashboards: "Use create_dashboard to create a live HTML dashboard rendered in a sandboxed iframe. Always fetch data via window.cairn.query(tool, args) — never bake in static data. Available query tools: get_cairn_context, get_project_summary, list_tasks, list_notes, list_recent_activity, search_tasks, search_notes.",
          tasks: "Always provide columnId (not just projectId) when creating a task.",
          priority: ["low", "medium", "high", "urgent"],
          projectStatus: ["active", "on_hold", "completed", "archived"],
          columnTypes: ["backlog", "todo", "in_progress", "review", "done", "custom"],
          createProject: "create_project auto-creates 5 default columns — no need to create them separately.",
        },
      };
    }
    case "get_active_context": {
      const workspace = snap.workspaces.find((w) => w.id === req.workspaceId) ?? snap.workspaces[0];
      const project = snap.projects.find((p) => p.id === req.projectId)
        ?? snap.projects.filter((p) => !p.archivedAt)[0];

      const columns = project
        ? snap.columns
            .filter((c) => c.projectId === project.id)
            .sort((a, b) => a.order - b.order)
            .map((col) => ({
              columnId: col.id,
              name: col.name,
              type: col.type,
              taskCount: snap.cards.filter((c) => c.columnId === col.id && !c.archivedAt).length,
            }))
        : [];

      const recentNotes = snap.notes
        .filter((n) => !n.archivedAt && (!project || n.projectId === project.id))
        .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
        .slice(0, 10)
        .map((n) => ({ noteId: n.id, title: n.title, updatedAt: n.updatedAt }));

      // Include recent tasks per column so task-related queries don't need a separate list_tasks call
      const recentTasks = columns.map((col) => ({
        columnId: col.columnId,
        columnName: col.name,
        tasks: snap.cards
          .filter((c) => c.columnId === col.columnId && !c.archivedAt)
          .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
          .slice(0, 5)
          .map((c) => ({ taskId: c.id, title: c.title, priority: c.priority, dueDate: c.dueDate ?? null })),
      }));

      const allProjects = snap.projects
        .filter((p) => !p.archivedAt)
        .map((p) => ({ projectId: p.id, name: p.name, status: p.status }));

      return {
        workspace: workspace ? { workspaceId: workspace.id, name: workspace.name } : null,
        activeProject: project ? { projectId: project.id, name: project.name, status: project.status } : null,
        allProjects,
        columns,
        recentNotes,
        recentTasks,
      };
    }
    case "get_note": {
      const note = snap.notes.find((n) => n.id === args.noteId);
      if (!note) return { error: "Note not found" };
      return { id: note.id, title: note.title, content: note.content, projectId: note.projectId, updatedAt: note.updatedAt };
    }
    case "list_notes": {
      return snap.notes
        .filter((n) => !n.archivedAt && (!args.projectId || n.projectId === args.projectId))
        .map((n) => ({ id: n.id, title: n.title, projectId: n.projectId, isPinned: n.isPinned, updatedAt: n.updatedAt }));
    }
    case "list_tasks": {
      const cols = snap.columns.filter((c) => !args.projectId || c.projectId === args.projectId);
      return cols
        .filter((c) => !args.columnType || c.type === args.columnType)
        .sort((a, b) => a.order - b.order)
        .map((col) => ({
          columnName: col.name,
          columnType: col.type,
          columnId: col.id,
          tasks: snap.cards
            .filter((c) => c.columnId === col.id && !c.archivedAt)
            .map((c) => ({ id: c.id, title: c.title, priority: c.priority, description: c.description })),
        }));
    }
    case "search_notes": {
      const qr = (args.query as string).toLowerCase();
      return snap.notes
        .filter((n) => !n.archivedAt &&
          (!args.projectId || n.projectId === args.projectId) &&
          (n.title.toLowerCase().includes(qr) || n.contentText.toLowerCase().includes(qr)))
        .slice(0, args.limit ?? 10)
        .map((n) => ({ id: n.id, title: n.title, snippet: n.contentText.slice(0, 200), projectId: n.projectId }));
    }
    case "search_tasks": {
      const qr = (args.query as string).toLowerCase();
      return snap.cards
        .filter((c) => !c.archivedAt &&
          (!args.projectId || c.projectId === args.projectId) &&
          c.title.toLowerCase().includes(qr))
        .slice(0, args.limit ?? 10)
        .map((c) => ({ id: c.id, title: c.title, columnId: c.columnId, priority: c.priority, projectId: c.projectId }));
    }
    case "get_project_summary": {
      const project = snap.projects.find((p) => p.id === args.projectId);
      if (!project) return { error: "Project not found" };
      const columns = snap.columns.filter((c) => c.projectId === args.projectId).sort((a, b) => a.order - b.order);
      return {
        project: { id: project.id, name: project.name, status: project.status, priority: project.priority },
        noteCount: snap.notes.filter((n) => n.projectId === args.projectId && !n.archivedAt).length,
        cardsByColumn: columns.map((col) => ({
          columnName: col.name,
          columnType: col.type,
          count: snap.cards.filter((c) => c.columnId === col.id && !c.archivedAt).length,
          cards: snap.cards.filter((c) => c.columnId === col.id && !c.archivedAt).map((c) => ({ id: c.id, title: c.title, priority: c.priority })),
        })),
      };
    }
    case "create_dashboard": {
      const project = snap.projects.find((p) => p.id === args.projectId);
      if (!project) return { error: "Project not found" };
      const noteId = newId();
      const html = (args.html as string) ?? "";
      const note = q.createNote(db, {
        id: noteId, projectId: args.projectId, workspaceId: project.workspaceId,
        title: args.title, content: html, contentText: "", type: "dashboard",
      });
      return { id: note.id, title: note.title, type: "dashboard" };
    }
    case "update_dashboard": {
      const existing = snap.notes.find((n) => n.id === args.noteId);
      if (!existing) return { error: "Dashboard not found" };
      const patch: { title?: string; content?: string; contentText?: string } = {};
      if (args.title) patch.title = args.title as string;
      if (args.html !== undefined) { patch.content = args.html as string; patch.contentText = ""; }
      return q.updateNote(db, args.noteId as string, patch);
    }
    case "create_note": {
      const project = snap.projects.find((p) => p.id === args.projectId);
      if (!project) return { error: "Project not found" };
      const noteId = newId();
      const markdown = (args.content as string) ?? "";
      const note = q.createNote(db, {
        id: noteId, projectId: args.projectId, workspaceId: project.workspaceId,
        title: args.title, content: markdown, contentText: stripMarkdown(markdown),
      });
      writeNoteFile(workspacePath, { ...note, projectName: project.name });
      return note;
    }
    case "update_note": {
      const existing = snap.notes.find((n) => n.id === args.noteId);
      if (!existing) return { error: "Note not found" };
      const patch: { title?: string; content?: string; contentText?: string } = {};
      if (args.title !== undefined && args.title !== "") patch.title = args.title as string;
      if (args.content !== undefined) {
        patch.content = args.content as string;
        patch.contentText = stripMarkdown(args.content as string);
      }
      const note = q.updateNote(db, args.noteId as string, patch);
      const proj = snap.projects.find((p) => p.id === note.projectId);
      writeNoteFile(workspacePath, { ...note, projectName: proj?.name ?? note.projectId });
      return note;
    }
    case "create_task": {
      const col = snap.columns.find((c) => c.id === args.columnId);
      if (!col) return { error: "Column not found" };
      const cardId = newId();
      // Query live count so concurrent creates in the same round get unique order values
      const order = q.getCards(db, { columnId: args.columnId as string }).length;
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      return q.createCard(db, {
        id: cardId, columnId: args.columnId, projectId: args.projectId,
        workspaceId: col.workspaceId, title: args.title,
        description: args.description ?? null, priority: args.priority ?? "medium",
        dueDate: undefined, order,
      });
    }
    case "update_task_status": {
      const card = snap.cards.find((c) => c.id === args.cardId);
      if (!card) return { error: "Task not found" };
      const col = snap.columns.find((c) => c.id === args.targetColumnId);
      if (!col) return { error: "Column not found" };
      return q.updateCard(db, args.cardId as string, { columnId: args.targetColumnId as string });
    }
    case "create_project": {
      const projectId = newId();
      const project = q.createProject(db, {
        id: projectId, workspaceId: args.workspaceId, name: args.name,
        description: args.description ?? undefined, icon: args.icon ?? undefined,
        status: args.status ?? "active", priority: args.priority ?? "medium",
      });
      const defaultColumns = [
        { name: "Backlog",     type: "backlog",      order: 0 },
        { name: "Todo",        type: "todo",         order: 1 },
        { name: "In Progress", type: "in_progress",  order: 2 },
        { name: "Review",      type: "review",       order: 3 },
        { name: "Done",        type: "done",         order: 4 },
      ];
      const columns = defaultColumns.map((col) =>
        q.createColumn(db, { id: newId(), projectId, workspaceId: args.workspaceId, ...col })
      );
      return { project, columns: columns.map((c) => ({ id: c.id, name: c.name, type: c.type })) };
    }
    case "get_task": {
      const card = snap.cards.find((c) => c.id === args.cardId);
      if (!card) return { error: "Task not found" };
      const col = snap.columns.find((c) => c.id === card.columnId);
      return {
        id: card.id, title: card.title, description: card.description,
        priority: card.priority, dueDate: card.dueDate,
        columnId: card.columnId, columnName: col?.name ?? "Unknown", columnType: col?.type ?? "custom",
        linkedNoteIds: card.linkedNoteIds, projectId: card.projectId,
        createdAt: card.createdAt, updatedAt: card.updatedAt,
      };
    }
    case "delete_note": {
      const note = snap.notes.find((n) => n.id === args.noteId);
      if (!note) return { error: "Note not found" };
      const proj = snap.projects.find((p) => p.id === note.projectId);
      q.deleteNote(db, args.noteId as string);
      deleteNoteFile(workspacePath, proj?.name ?? note.projectId, args.noteId as string);
      return { deleted: true, id: args.noteId, title: note.title };
    }
    case "delete_task": {
      const card = snap.cards.find((c) => c.id === args.cardId);
      if (!card) return { error: "Task not found" };
      q.deleteCard(db, args.cardId as string);
      return { deleted: true, id: args.cardId, title: card.title };
    }
    case "generate_prd": {
      const project = snap.projects.find((p) => p.id === args.projectId);
      if (!project) return { error: "Project not found" };

      const systemPrompt = `You are an expert product manager. Generate a thorough, well-structured Product Requirements Document (PRD) in markdown format. Include all standard sections. Be specific and actionable.`;
      const userPrompt = `Generate a complete PRD for the following:\n\n${args.requirements as string}\n\nInclude these sections:\n# ${args.title as string}\n\n## Overview\n## Problem Statement\n## Goals & Non-Goals\n## User Stories\n## Functional Requirements\n## Non-Functional Requirements\n## Acceptance Criteria\n## Open Questions\n\nReturn only the markdown document, no commentary.`;

      let prdMarkdown: string;
      try {
        prdMarkdown = await callLLM(llmConfig, systemPrompt, userPrompt);
      } catch (err) {
        return { error: `Failed to generate PRD: ${(err as Error).message}` };
      }

      const noteId = newId();
      const note = q.createNote(db, {
        id: noteId, projectId: args.projectId as string, workspaceId: project.workspaceId,
        title: args.title as string, content: prdMarkdown, contentText: stripMarkdown(prdMarkdown),
      });
      writeNoteFile(workspacePath, { ...note, projectName: project.name });
      return { id: note.id, title: note.title, projectId: note.projectId, content: prdMarkdown };
    }
    case "spawn_tasks_from_note": {
      const note = snap.notes.find((n) => n.id === args.noteId);
      if (!note) return { error: "Note not found" };
      const col = snap.columns.find((c) => c.id === args.columnId);
      if (!col) return { error: "Column not found" };
      const project = snap.projects.find((p) => p.id === col.projectId);

      const systemPrompt = `You are an expert project manager. Extract a list of actionable development tasks from the given document. Return ONLY a valid JSON array, nothing else. Each item must have: title (string), description (string, 1-2 sentences), priority ("low"|"medium"|"high"|"urgent").`;
      const userPrompt = `Extract tasks from this document:\n\n${note.content ?? note.contentText}`;

      let tasksRaw: string;
      try {
        tasksRaw = await callLLM(llmConfig, systemPrompt, userPrompt);
      } catch (err) {
        return { error: `Failed to generate tasks: ${(err as Error).message}` };
      }

      // Parse JSON — strip potential markdown code fence
      let tasks: Array<{ title: string; description: string; priority: string }> = [];
      try {
        const jsonStr = tasksRaw.replace(/^```(?:json)?\n?/i, "").replace(/\n?```$/i, "").trim();
        tasks = JSON.parse(jsonStr);
      } catch {
        return { error: `Could not parse task list from AI response: ${tasksRaw.slice(0, 200)}` };
      }

      const createdCards = [];
      const existingCount = snap.cards.filter((c) => c.columnId === args.columnId).length;
      for (let i = 0; i < tasks.length; i++) {
        const task = tasks[i];
        const cardId = newId();
        emit?.({ tool: "create_task", label: `Creating task "${task.title}"`, args: { title: task.title } });
        const card = q.createCard(db, {
          id: cardId, columnId: args.columnId as string,
          projectId: col.projectId, workspaceId: col.workspaceId,
          title: task.title, description: task.description,
          priority: task.priority ?? "medium",
          order: existingCount + i,
        });
        // Link card → note
        q.updateCard(db, cardId, { linkedNoteIds: [args.noteId as string] });
        createdCards.push({ id: card.id, title: card.title, priority: card.priority });
      }

      // Link note → all created cards
      const existingCardIds = note.linkedCardIds ?? [];
      const newCardIds = createdCards.map((c) => c.id);
      const updatedNote = q.updateNote(db, args.noteId as string, {
        linkedCardIds: [...existingCardIds, ...newCardIds],
      });
      writeNoteFile(workspacePath, { ...updatedNote, projectName: project?.name ?? col.projectId });

      return { tasksCreated: createdCards.length, tasks: createdCards, noteId: args.noteId };
    }
    case "update_task": {
      const card = snap.cards.find((c) => c.id === args.taskId);
      if (!card) return { error: "Task not found" };
      const patch: Record<string, unknown> = {};
      if (args.title !== undefined)       patch.title       = args.title;
      if (args.description !== undefined) patch.description = args.description;
      if (args.priority !== undefined)    patch.priority    = args.priority;
      if (args.dueDate !== undefined)     patch.dueDate     = args.dueDate || undefined;
      if (args.columnId !== undefined)    patch.columnId    = args.columnId;
      if (args.assignee !== undefined)    patch.assignee    = args.assignee || undefined;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return q.updateCard(db, args.taskId as string, patch as any);
    }
    case "link_note_to_task": {
      const note = snap.notes.find((n) => n.id === args.noteId);
      if (!note) return { error: "Note not found" };
      const card = snap.cards.find((c) => c.id === args.cardId);
      if (!card) return { error: "Task not found" };
      const project = snap.projects.find((p) => p.id === note.projectId);

      // Add card to note's linkedCardIds (deduped)
      const noteCardIds = [...new Set([...(note.linkedCardIds ?? []), args.cardId as string])];
      const updatedNote = q.updateNote(db, args.noteId as string, { linkedCardIds: noteCardIds });
      writeNoteFile(workspacePath, { ...updatedNote, projectName: project?.name ?? note.projectId });

      // Add note to card's linkedNoteIds (deduped)
      const cardNoteIds = [...new Set([...(card.linkedNoteIds ?? []), args.noteId as string])];
      q.updateCard(db, args.cardId as string, { linkedNoteIds: cardNoteIds });

      return { linked: true, noteId: args.noteId, cardId: args.cardId };
    }
    default:
      return { error: `Unknown tool: ${name}` };
  }
}

/**
 * Run the tool-call loop. Returns when the model produces a response with no
 * tool calls (ready to stream) or when the round limit is hit.
 *
 * Returns { messages, finalContent } where finalContent is set only when the
 * loop exits via round-limit (so the caller knows to send a canned reply).
 */
async function runToolLoop(
  db: Database.Database,
  req: ChatRequest,
  workspacePath: string,
  baseUrl: string,
  model: string,
  apiKey: string,
  messages: OpenAIMessage[],
  emitToolCall: (e: { tool: string; label: string; args: Record<string, unknown> }) => void,
): Promise<{ exhausted: true; content: string } | { exhausted: false }> {
  for (let round = 0; round < 8; round++) {
    let response: Response;
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
      response = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify({ model, messages, tools: TOOLS, tool_choice: "auto", max_tokens: 4096, temperature: 0.3 }),
      });
    } catch (err) {
      return { exhausted: true, content: `Could not reach the AI endpoint at \`${baseUrl}\`. Check your endpoint URL and make sure the server is running.` };
    }

    if (!response.ok) {
      const errText = await response.text().catch(() => response.statusText);
      return { exhausted: true, content: `AI endpoint error (${response.status}): ${errText.slice(0, 300)}` };
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = await response.json() as any;
    const choice = data.choices?.[0];
    if (!choice) return { exhausted: true, content: "No response from AI endpoint." };

    const assistantMsg = choice.message as OpenAIMessage;

    // No tool calls — model is ready to produce its final reply
    if (!assistantMsg.tool_calls?.length) {
      // Push the non-streaming reply so the caller can stream it
      messages.push(assistantMsg);
      return { exhausted: false };
    }

    messages.push(assistantMsg);
    for (const call of assistantMsg.tool_calls) {
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(call.function.arguments); } catch { args = {}; }
      let result: unknown;
      try {
        result = await executeTool(db, req, workspacePath, { baseUrl, model, apiKey }, call.function.name, args, emitToolCall);
      } catch (toolErr) {
        result = { error: `Tool "${call.function.name}" failed: ${String(toolErr)}` };
      }
      messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
    }
  }

  return {
    exhausted: true,
    content: "I reached the maximum number of steps for this request. Any actions taken so far have been saved — check your board and notes. Try breaking the request into smaller steps.",
  };
}

export function registerChatHandler(db: Database.Database, workspacePath: string): void {
  // chat:stream — fire-and-forget (ipcMain.on, not handle).
  // Emits:
  //   chat:token   { delta: string }   — one SSE content chunk
  //   chat:tool-call { tool, label, args } — tool being invoked
  //   chat:done    { content: string, contextRefs: [], error?: string }
  ipcMain.on("chat:stream", async (event, req: ChatRequest) => {
    const baseUrl = (req.config?.baseUrl ?? "https://api.openai.com").replace(/\/$/, "");
    const model = req.config?.model ?? "gpt-4o-mini";
    const apiKey = req.config?.apiKey ?? "";
    const isLocal = baseUrl.includes("localhost") || baseUrl.includes("127.0.0.1") || baseUrl.includes("0.0.0.0");

    const send = (ch: string, payload: unknown) => {
      if (!event.sender.isDestroyed()) event.sender.send(ch, payload);
    };

    if (!apiKey && !isLocal) {
      send("chat:done", {
        content: "AI chat is not configured. Set an API key in **Settings → AI & Chat**, or use a local endpoint (Ollama, LM Studio) with no key needed.",
        contextRefs: [],
      });
      return;
    }

    const messages: OpenAIMessage[] = [
      { role: "system", content: buildSystemPrompt(req) },
      ...(req.history ?? []).map((m) => ({ role: m.role, content: m.content })),
      { role: "user", content: req.message },
    ];

    const emitToolCall = (e: { tool: string; label: string; args: Record<string, unknown> }) => {
      send("chat:tool-call", e);
    };

    // Run tool loop until model has no more tool calls
    const loopResult = await runToolLoop(db, req, workspacePath, baseUrl, model, apiKey, messages, emitToolCall);

    if (loopResult.exhausted) {
      send("chat:done", { content: loopResult.content, contextRefs: [] });
      return;
    }

    // The last message pushed by runToolLoop is the non-tool-call assistant turn.
    // Pop it off — we'll re-request with stream:true so the reply comes token by token.
    // (If the model answered with content in that turn, we can stream it directly without
    //  a second request — just emit it character by character for a smooth effect.)
    const lastMsg = messages[messages.length - 1] as OpenAIMessage;

    // Fast path: model already gave us the full content in the non-streaming pass.
    // Emit it as a stream so the UI behaviour is identical.
    if (lastMsg.role === "assistant" && lastMsg.content && !lastMsg.tool_calls?.length) {
      // Remove the already-appended assistant turn so we can stream it properly
      messages.pop();

      // Request again with stream: true so we get real SSE
      let streamResp: Response;
      try {
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
        streamResp = await fetch(`${baseUrl}/v1/chat/completions`, {
          method: "POST",
          headers,
          body: JSON.stringify({ model, messages, tools: TOOLS, tool_choice: "none", max_tokens: 4096, temperature: 0.3, stream: true }),
        });
      } catch {
        // Fallback: just emit the already-received content verbatim
        send("chat:token", { delta: lastMsg.content });
        send("chat:done", { content: lastMsg.content, contextRefs: [] });
        return;
      }

      if (!streamResp.ok) {
        // Fallback to the already-buffered content
        send("chat:token", { delta: lastMsg.content });
        send("chat:done", { content: lastMsg.content, contextRefs: [] });
        return;
      }

      // Read SSE stream
      let fullContent = "";
      try {
        const reader = streamResp.body?.getReader();
        const decoder = new TextDecoder();
        if (!reader) throw new Error("No readable stream");

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value, { stream: true });
          for (const line of chunk.split("\n")) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data:")) continue;
            const jsonStr = trimmed.slice(5).trim();
            if (jsonStr === "[DONE]") break;
            try {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const parsed = JSON.parse(jsonStr) as any;
              const delta: string = parsed.choices?.[0]?.delta?.content ?? "";
              if (delta) {
                fullContent += delta;
                send("chat:token", { delta });
              }
            } catch { /* skip malformed lines */ }
          }
        }
      } catch {
        // If streaming breaks mid-way, emit whatever we have
        if (!fullContent) fullContent = lastMsg.content ?? "";
      }

      send("chat:done", { content: fullContent || (lastMsg.content ?? ""), contextRefs: [] });
      return;
    }

    // Unexpected state — shouldn't happen, but be safe
    send("chat:done", { content: "", contextRefs: [] });
  });
}
