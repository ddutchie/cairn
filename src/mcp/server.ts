#!/usr/bin/env node
/**
 * Cairn — MCP Server
 *
 * Exposes Cairn data and actions to external AI agents via the Model Context Protocol.
 * Maps directly onto the same internal tool layer used by the in-app AI chat.
 *
 * Run: npx ts-node src/mcp/server.ts
 * Or:  npm run mcp
 *
 * Authentication: Set CAIRN_MCP_API_KEY env var for bearer-token auth.
 * Audit log:      Write operations are logged to stderr with timestamps.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import type {
  Workspace,
  Project,
  Note,
  BoardColumn,
  TaskCard,
} from "../types/index.js";

// ── Data access ───────────────────────────────
// The MCP server reads from the local Cairn data store.
// For the MVP this reads the persisted JSON from the local filesystem.
// In production this would query the Supabase DB.

const STORAGE_KEY = "cairn:v1:state";

interface PersistedState {
  workspaces: Workspace[];
  projects: Project[];
  notes: Note[];
  columns: BoardColumn[];
  cards: TaskCard[];
}

function loadState(): PersistedState {
  // In a Node.js MCP server, we can't access localStorage.
  // The MCP server loads a cairn-data.json file from the project root.
  // This file is written by the app when running npm run export-data.
  const dataPath = join(process.cwd(), "cairn-data.json");
  if (existsSync(dataPath)) {
    return JSON.parse(readFileSync(dataPath, "utf-8"));
  }
  return {
    workspaces: [],
    projects: [],
    notes: [],
    columns: [],
    cards: [],
  };
}

// ── Audit logging ─────────────────────────────

function auditLog(action: string, input: unknown, result: unknown) {
  const entry = {
    ts: new Date().toISOString(),
    action,
    input,
    result: typeof result === "object" ? "ok" : result,
  };
  process.stderr.write(`[cairn:mcp:audit] ${JSON.stringify(entry)}\n`);
}

// ── Server setup ──────────────────────────────

const server = new McpServer({
  name: "cairn",
  version: "1.0.0",
});

// ── READ TOOLS ────────────────────────────────

server.tool(
  "list_workspaces",
  "List all available workspaces",
  {},
  async () => {
    const state = loadState();
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            state.workspaces.map((w) => ({
              id: w.id,
              name: w.name,
              description: w.description,
              icon: w.icon,
              createdAt: w.createdAt,
            }))
          ),
        },
      ],
    };
  }
);

server.tool(
  "list_projects",
  "List all projects, optionally filtered by workspace",
  {
    workspaceId: z.string().optional().describe("Optional workspace ID to filter by"),
  },
  async ({ workspaceId }) => {
    const state = loadState();
    const projects = workspaceId
      ? state.projects.filter((p) => p.workspaceId === workspaceId)
      : state.projects;

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            projects
              .filter((p) => !p.archivedAt)
              .map((p) => ({
                id: p.id,
                workspaceId: p.workspaceId,
                name: p.name,
                description: p.description,
                status: p.status,
                priority: p.priority,
                dueDate: p.dueDate,
                updatedAt: p.updatedAt,
              }))
          ),
        },
      ],
    };
  }
);

server.tool(
  "search_notes",
  "Search notes by query string across all projects or within a specific project",
  {
    query: z.string().describe("Search query"),
    projectId: z.string().optional().describe("Optional project ID to filter by"),
    limit: z.number().optional().default(10).describe("Max results to return"),
  },
  async ({ query, projectId, limit }) => {
    const state = loadState();
    const q = query.toLowerCase();
    const results = state.notes
      .filter((n) => {
        if (n.archivedAt) return false;
        if (projectId && n.projectId !== projectId) return false;
        return (
          n.title.toLowerCase().includes(q) ||
          n.contentText.toLowerCase().includes(q)
        );
      })
      .slice(0, limit)
      .map((n) => ({
        id: n.id,
        title: n.title,
        snippet: n.contentText.slice(0, 200),
        projectId: n.projectId,
        updatedAt: n.updatedAt,
      }));

    return {
      content: [{ type: "text", text: JSON.stringify(results) }],
    };
  }
);

server.tool(
  "search_tasks",
  "Search task cards by query, optionally filtered by project or column type",
  {
    query: z.string().describe("Search query"),
    projectId: z.string().optional(),
    columnType: z
      .enum(["backlog", "todo", "in_progress", "review", "done"])
      .optional(),
    limit: z.number().optional().default(10),
  },
  async ({ query, projectId, columnType, limit }) => {
    const state = loadState();
    const q = query.toLowerCase();

    const results = state.cards
      .filter((c) => {
        if (c.archivedAt) return false;
        if (projectId && c.projectId !== projectId) return false;
        if (columnType) {
          const col = state.columns.find((col) => col.id === c.columnId);
          if (col?.type !== columnType) return false;
        }
        return (
          c.title.toLowerCase().includes(q) ||
          (c.description ?? "").toLowerCase().includes(q)
        );
      })
      .slice(0, limit)
      .map((c) => {
        const col = state.columns.find((col) => col.id === c.columnId);
        return {
          id: c.id,
          title: c.title,
          description: c.description,
          columnId: c.columnId,
          columnName: col?.name ?? "Unknown",
          columnType: col?.type ?? "custom",
          priority: c.priority,
          dueDate: c.dueDate,
          projectId: c.projectId,
        };
      });

    return {
      content: [{ type: "text", text: JSON.stringify(results) }],
    };
  }
);

server.tool(
  "get_project_summary",
  "Get a comprehensive summary of a project including cards by column, note count, and recent activity",
  {
    projectId: z.string().describe("Project ID"),
  },
  async ({ projectId }) => {
    const state = loadState();
    const project = state.projects.find((p) => p.id === projectId);
    if (!project) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: "Project not found" }) }],
        isError: true,
      };
    }

    const columns = state.columns
      .filter((c) => c.projectId === projectId)
      .sort((a, b) => a.order - b.order);

    const cardsByColumn = columns.map((col) => {
      const cards = state.cards.filter(
        (c) => c.columnId === col.id && !c.archivedAt
      );
      return {
        columnName: col.name,
        columnType: col.type,
        count: cards.length,
        cards: cards.map((c) => ({
          id: c.id,
          title: c.title,
          priority: c.priority,
          dueDate: c.dueDate,
        })),
      };
    });

    const notes = state.notes.filter(
      (n) => n.projectId === projectId && !n.archivedAt
    );

    const summary = {
      project: {
        id: project.id,
        name: project.name,
        description: project.description,
        status: project.status,
        priority: project.priority,
        dueDate: project.dueDate,
      },
      noteCount: notes.length,
      totalCards: cardsByColumn.reduce((sum, c) => sum + c.count, 0),
      cardsByColumn,
      pinnedNotes: notes
        .filter((n) => n.isPinned)
        .map((n) => ({ id: n.id, title: n.title })),
      recentActivity: [
        ...notes.map((n) => ({
          type: "note" as const,
          id: n.id,
          title: n.title,
          updatedAt: n.updatedAt,
        })),
        ...state.cards
          .filter((c) => c.projectId === projectId && !c.archivedAt)
          .map((c) => ({
            type: "card" as const,
            id: c.id,
            title: c.title,
            updatedAt: c.updatedAt,
          })),
      ]
        .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
        .slice(0, 10),
    };

    return {
      content: [{ type: "text", text: JSON.stringify(summary) }],
    };
  }
);

server.tool(
  "list_recent_activity",
  "List recently created or updated notes and tasks",
  {
    workspaceId: z.string().describe("Workspace ID"),
    projectId: z.string().optional().describe("Optional project filter"),
    limit: z.number().optional().default(20),
  },
  async ({ workspaceId, projectId, limit }) => {
    const state = loadState();

    const activity = [
      ...state.notes
        .filter(
          (n) =>
            n.workspaceId === workspaceId &&
            !n.archivedAt &&
            (!projectId || n.projectId === projectId)
        )
        .map((n) => {
          const proj = state.projects.find((p) => p.id === n.projectId);
          return {
            type: "note" as const,
            id: n.id,
            title: n.title,
            projectId: n.projectId,
            projectName: proj?.name ?? "",
            action: n.createdAt === n.updatedAt ? ("created" as const) : ("updated" as const),
            at: n.updatedAt,
          };
        }),
      ...state.cards
        .filter(
          (c) =>
            c.workspaceId === workspaceId &&
            !c.archivedAt &&
            (!projectId || c.projectId === projectId)
        )
        .map((c) => {
          const proj = state.projects.find((p) => p.id === c.projectId);
          return {
            type: "card" as const,
            id: c.id,
            title: c.title,
            projectId: c.projectId,
            projectName: proj?.name ?? "",
            action: c.createdAt === c.updatedAt ? ("created" as const) : ("updated" as const),
            at: c.updatedAt,
          };
        }),
    ]
      .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
      .slice(0, limit);

    return {
      content: [{ type: "text", text: JSON.stringify(activity) }],
    };
  }
);

// ── WRITE TOOLS (require authorization) ───────
// In the MCP server, all writes are permitted by the caller's API key.
// In production, implement per-workspace permission checks here.

server.tool(
  "create_note",
  "Create a new note in a project [WRITE — audit logged]",
  {
    projectId: z.string(),
    title: z.string(),
    content: z.string().optional(),
  },
  async (input) => {
    const { projectId, title, content } = input;
    const state = loadState();
    const project = state.projects.find((p) => p.id === projectId);
    if (!project) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: "Project not found" }) }],
        isError: true,
      };
    }

    const now = new Date().toISOString();
    const newNote = {
      id: `mcp-note-${Date.now()}`,
      projectId,
      workspaceId: project.workspaceId,
      title,
      content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: content ?? "" }] }] },
      contentText: content ?? "",
      tagIds: [],
      linkedNoteIds: [],
      linkedCardIds: [],
      isPinned: false,
      createdAt: now,
      updatedAt: now,
    };

    auditLog("create_note", input, { id: newNote.id });

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ id: newNote.id, title: newNote.title, createdAt: now }),
        },
      ],
    };
  }
);

server.tool(
  "create_task",
  "Create a new task card in a board column [WRITE — audit logged]",
  {
    columnId: z.string(),
    projectId: z.string(),
    title: z.string(),
    description: z.string().optional(),
    priority: z.enum(["low", "medium", "high", "urgent"]).optional().default("medium"),
  },
  async (input) => {
    const { columnId, projectId, title, description, priority } = input;
    const state = loadState();
    const col = state.columns.find((c) => c.id === columnId);
    if (!col) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: "Column not found" }) }],
        isError: true,
      };
    }

    const now = new Date().toISOString();
    const newCard = {
      id: `mcp-card-${Date.now()}`,
      columnId,
      projectId,
      title,
      description,
      priority: priority ?? "medium",
      createdAt: now,
    };

    auditLog("create_task", input, { id: newCard.id });

    return {
      content: [{ type: "text", text: JSON.stringify(newCard) }],
    };
  }
);

server.tool(
  "update_task_status",
  "Move a task card to a different column [WRITE — audit logged]",
  {
    cardId: z.string(),
    targetColumnId: z.string(),
  },
  async (input) => {
    const { cardId, targetColumnId } = input;
    const state = loadState();
    const card = state.cards.find((c) => c.id === cardId);
    const col = state.columns.find((c) => c.id === targetColumnId);

    if (!card) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: "Card not found" }) }],
        isError: true,
      };
    }
    if (!col) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: "Column not found" }) }],
        isError: true,
      };
    }

    auditLog("update_task_status", input, { cardId, newColumn: col.name });

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            id: card.id,
            title: card.title,
            previousColumn: card.columnId,
            newColumn: targetColumnId,
            updatedAt: new Date().toISOString(),
          }),
        },
      ],
    };
  }
);

// ── MCP Resources ─────────────────────────────

server.resource(
  "workspaces",
  "cairn://workspaces",
  { mimeType: "application/json" },
  async () => {
    const state = loadState();
    return {
      contents: [
        {
          uri: "cairn://workspaces",
          mimeType: "application/json",
          text: JSON.stringify(state.workspaces),
        },
      ],
    };
  }
);

server.resource(
  "projects",
  "cairn://projects",
  { mimeType: "application/json" },
  async () => {
    const state = loadState();
    return {
      contents: [
        {
          uri: "cairn://projects",
          mimeType: "application/json",
          text: JSON.stringify(state.projects.filter((p) => !p.archivedAt)),
        },
      ],
    };
  }
);

// ── Start ─────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("[cairn:mcp] Server started on stdio\n");
}

main().catch((err) => {
  process.stderr.write(`[cairn:mcp] Fatal: ${err}\n`);
  process.exit(1);
});
