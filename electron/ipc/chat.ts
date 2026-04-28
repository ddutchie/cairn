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

Tone: calm, focused, like a thoughtful co-worker.`;
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
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function executeTool(db: Database.Database, req: ChatRequest, workspacePath: string, name: string, args: Record<string, any>): unknown {
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
          write:  ["create_project", "create_note", "update_note", "create_task", "update_task_status", "link_note_to_task"],
          delete: ["delete_note", "delete_task"],
        },
        conventions: {
          notes: "Raw markdown in 'content'. 'content_text' is auto-derived — do not set manually.",
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

      const allProjects = snap.projects
        .filter((p) => !p.archivedAt)
        .map((p) => ({ projectId: p.id, name: p.name, status: p.status }));

      return {
        workspace: workspace ? { workspaceId: workspace.id, name: workspace.name } : null,
        activeProject: project ? { projectId: project.id, name: project.name, status: project.status } : null,
        allProjects,
        columns,
        recentNotes,
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
      const patch: { title?: string; content?: string; contentText?: string } = {};
      if (args.title) patch.title = args.title;
      if (args.content !== undefined) {
        patch.content = args.content;
        patch.contentText = stripMarkdown(args.content as string);
      }
      const note = q.updateNote(db, args.noteId, patch);
      const proj = snap.projects.find((p) => p.id === note.projectId);
      writeNoteFile(workspacePath, { ...note, projectName: proj?.name ?? note.projectId });
      return note;
    }
    case "create_task": {
      const col = snap.columns.find((c) => c.id === args.columnId);
      if (!col) return { error: "Column not found" };
      const cardId = newId();
      const order = snap.cards.filter((c) => c.columnId === args.columnId).length;
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      return q.createCard(db, {
        id: cardId, columnId: args.columnId, projectId: args.projectId,
        workspaceId: col.workspaceId, title: args.title,
        description: args.description ?? null, priority: args.priority ?? "medium",
        dueDate: undefined, order,
      });
    }
    case "update_task_status": {
      return q.updateCard(db, args.cardId, { columnId: args.targetColumnId });
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
    default:
      return { error: `Unknown tool: ${name}` };
  }
}

export function registerChatHandler(db: Database.Database, workspacePath: string): void {
  ipcMain.handle("chat:send", async (_event, req: ChatRequest) => {
    const baseUrl = (req.config?.baseUrl ?? "https://api.openai.com").replace(/\/$/, "");
    const model = req.config?.model ?? "gpt-4o-mini";
    const apiKey = req.config?.apiKey ?? "";
    const isLocal = baseUrl.includes("localhost") || baseUrl.includes("127.0.0.1") || baseUrl.includes("0.0.0.0");

    if (!apiKey && !isLocal) {
      return {
        content: "AI chat is not configured. Set an API key in **Settings → AI & Chat**, or use a local endpoint (Ollama, LM Studio) with no key needed.",
        contextRefs: [],
        mutations: null,
      };
    }

    const messages: OpenAIMessage[] = [
      { role: "system", content: buildSystemPrompt(req) },
      ...(req.history ?? []).map((m) => ({ role: m.role, content: m.content })),
      { role: "user", content: req.message },
    ];

    for (let round = 0; round < 5; round++) {
      let response: Response;
      try {
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
        response = await fetch(`${baseUrl}/v1/chat/completions`, {
          method: "POST",
          headers,
          body: JSON.stringify({ model, messages, tools: TOOLS, tool_choice: "auto", max_tokens: 1024, temperature: 0.3 }),
        });
      } catch (err) {
        return { content: `Could not reach the AI endpoint at \`${baseUrl}\`. Check your endpoint URL and make sure the server is running.`, contextRefs: [], mutations: null };
      }

      if (!response.ok) {
        const errText = await response.text().catch(() => response.statusText);
        return { content: `AI endpoint error (${response.status}): ${errText.slice(0, 300)}`, contextRefs: [], mutations: null };
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const data = await response.json() as any;
      const choice = data.choices?.[0];
      if (!choice) return { content: "No response from AI endpoint.", contextRefs: [], mutations: null };

      const assistantMsg = choice.message as OpenAIMessage;

      if (!assistantMsg.tool_calls?.length) {
        return { content: assistantMsg.content ?? "", contextRefs: [], mutations: null };
      }

      messages.push(assistantMsg);
      for (const call of assistantMsg.tool_calls) {
        let args: Record<string, unknown> = {};
        try { args = JSON.parse(call.function.arguments); } catch { args = {}; }
        const result = executeTool(db, req, workspacePath, call.function.name, args);
        messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
      }
    }

    return { content: "I ran out of steps trying to complete that. Please try rephrasing.", contextRefs: [], mutations: null };
  });
}
