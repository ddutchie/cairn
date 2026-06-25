/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Cairn — Shared read-only tool pure logic (snapshot-based)
 * No native or database dependencies — can be imported in any context
 * (including Electron main process, IPC handlers, and standalone MCP server).
 */

export interface CairnSnapshot {
  workspaces: Array<{ id: string; name: string; [k: string]: unknown }>;
  projects: Array<{
    id: string; workspaceId: string; name: string; description?: string;
    status: string; priority: string; dueDate?: string; archivedAt?: string;
    tagIds: string[]; createdAt: string; updatedAt: string;
  }>;
  notes: Array<{
    id: string; projectId: string; workspaceId: string; title: string;
    content: string; contentText: string; tagIds: string[];
    linkedNoteIds: string[]; linkedCardIds: string[];
    isPinned: boolean; type: string; folder?: string;
    createdAt: string; updatedAt: string; archivedAt?: string;
  }>;
  columns: Array<{
    id: string; projectId: string; workspaceId: string; name: string;
    type: string; order: number; createdAt: string; updatedAt: string;
  }>;
  cards: Array<{
    id: string; columnId: string; projectId: string; workspaceId: string;
    title: string; description?: string; priority: string; dueDate?: string;
    linkedNoteIds: string[]; blockedByIds: string[]; tagIds: string[]; order: number;
    assignee?: string; createdAt: string; updatedAt: string; archivedAt?: string;
  }>;
  tags: Array<{ id: string; workspaceId: string; name: string; color: string }>;
}

type Args = Record<string, any>;

export function executeGetProjectSummary(snap: CairnSnapshot, args: Args): unknown {
  const project = snap.projects.find((p) => p.id === args.projectId);
  if (!project) return { error: "Project not found" };
  const columns = snap.columns
    .filter((c) => c.projectId === args.projectId)
    .sort((a, b) => a.order - b.order);
  const notes = snap.notes.filter((n) => n.projectId === args.projectId && !n.archivedAt);
  const cardsByColumn = columns.map((col) => {
    const cards = snap.cards.filter((c) => c.columnId === col.id && !c.archivedAt);
    return {
      columnName: col.name,
      columnType: col.type,
      count: cards.length,
      cards: cards.map((c) => ({ id: c.id, title: c.title, priority: c.priority, dueDate: c.dueDate ?? null })),
    };
  });
  const totalCards = cardsByColumn.reduce((s, c) => s + c.count, 0);
  const recentActivity = [
    ...notes.map((n) => ({ type: "note" as const, id: n.id, title: n.title, updatedAt: n.updatedAt })),
    ...snap.cards
      .filter((c) => c.projectId === args.projectId && !c.archivedAt)
      .map((c) => ({ type: "card" as const, id: c.id, title: c.title, updatedAt: c.updatedAt })),
  ]
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .slice(0, 10);
  return {
    project: {
      id: project.id, name: project.name, description: project.description,
      status: project.status, priority: project.priority, dueDate: project.dueDate ?? null,
    },
    noteCount: notes.length,
    totalCards,
    cardsByColumn,
    pinnedNotes: notes.filter((n) => n.isPinned).map((n) => ({ id: n.id, title: n.title })),
    recentActivity,
  };
}

export function executeListTasks(snap: CairnSnapshot, args: Args): unknown {
  const cols = snap.columns
    .filter((c) => !args.projectId || c.projectId === args.projectId)
    .sort((a, b) => a.order - b.order);
  return cols
    .filter((c) => !args.columnType || c.type === args.columnType)
    .map((col) => ({
      columnName: col.name,
      columnType: col.type,
      columnId: col.id,
      tasks: snap.cards
        .filter((c) => c.columnId === col.id && !c.archivedAt)
        .map((c) => ({ id: c.id, title: c.title, priority: c.priority, description: c.description })),
    }));
}

export function executeListNotes(snap: CairnSnapshot, args: Args): unknown {
  return snap.notes
    .filter((n) => !n.archivedAt && (!args.projectId || n.projectId === args.projectId))
    .map((n) => ({ id: n.id, title: n.title, projectId: n.projectId, folder: n.folder ?? "", isPinned: n.isPinned, updatedAt: n.updatedAt }));
}

export function executeListRecentActivity(snap: CairnSnapshot, args: Args): unknown {
  const limit = (args.limit as number) ?? 20;
  const recentNotes = snap.notes
    .filter((n) => !n.archivedAt
      && (!args.workspaceId || n.workspaceId === args.workspaceId)
      && (!args.projectId || n.projectId === args.projectId))
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .slice(0, limit)
    .map((n) => ({ id: n.id, title: n.title, projectId: n.projectId, updatedAt: n.updatedAt }));
  const recentTasks = snap.cards
    .filter((c) => !c.archivedAt
      && (!args.workspaceId || c.workspaceId === args.workspaceId)
      && (!args.projectId || c.projectId === args.projectId))
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .slice(0, limit)
    .map((c) => ({ id: c.id, title: c.title, projectId: c.projectId, updatedAt: c.updatedAt }));
  return { recentNotes, recentTasks };
}

export function executeGetProjectContextPack(snap: CairnSnapshot, args: Args): unknown {
  const project = snap.projects.find((p) => p.id === args.projectId);
  if (!project) return { error: "Project not found" };
  const columns = snap.columns
    .filter((c) => c.projectId === project.id)
    .sort((a, b) => a.order - b.order);
  const notes = snap.notes.filter((n) => n.projectId === project.id && !n.archivedAt);
  const pinnedNotes = notes
    .filter((n) => n.isPinned)
    .map((n) => {
      const limit = 1000;
      const content = n.content ?? "";
      const truncated = content.length > limit
        ? content.slice(0, limit) + "\n\n... (content truncated, use get_note to read full note)"
        : content;
      return { id: n.id, title: n.title, folder: n.folder ?? "", content: truncated };
    });
  const openCards = columns
    .filter((col) => col.type !== "done")
    .map((col) => ({
      // `columnName` is dropped — the top-level `project.columns` array already
      // carries `{id, name, type}`, so the agent can cross-reference when it
      // needs the human-readable name. `columnType` is kept because tests
      // assert on it and it's the structural signal (which board phase).
      columnType: col.type,
      columnId: col.id,
      tasks: snap.cards
        .filter((c) => c.columnId === col.id && !c.archivedAt)
        .map((c) => {
          const limit = 400;
          const desc = c.description ?? "";
          const truncated = desc.length > limit
            ? desc.slice(0, limit) + "\n... (description truncated, use get_task to read full description)"
            : (c.description ?? null);
          const t: Record<string, unknown> = { id: c.id, title: c.title, priority: c.priority };
          if (truncated !== null) t.description = truncated;
          if (c.dueDate) t.dueDate = c.dueDate;
          return t;
        }),
    }))
    .filter((col) => col.tasks.length > 0);
  // recentActivity intentionally omits `updatedAt` from the emitted shape —
  // the array order *is* the recency signal (sorted newest-first), and tests
  // only inspect `id` ordering (mcp-server.test.ts:1317-1326 asserts
  // `activity.map(a => a.id)` ordering, not the `updatedAt` field itself).
  // We still sort by `updatedAt` internally; we just don't emit it.
  const recentActivity = (
    [
      ...notes.map((n) => ({ type: "note" as const, id: n.id, title: n.title, updatedAt: n.updatedAt })),
      ...snap.cards
        .filter((c) => c.projectId === project.id && !c.archivedAt)
        .map((c) => ({ type: "card" as const, id: c.id, title: c.title, updatedAt: c.updatedAt })),
    ] as Array<{ type: "note" | "card"; id: string; title: string; updatedAt: string }>
  )
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .slice(0, 10)
    // Strip `updatedAt` from the emitted shape; keep the sort order.
    .map(({ type, id, title }) => ({ type, id, title }));
  // Omit default `status: "active"` / `priority: "medium"` on the project
  // (agent's `get_cairn_context` conventions document these as defaults).
  const proj: Record<string, unknown> = {
    id: project.id, name: project.name,
  };
  if (project.description) proj.description = project.description;
  if (project.status && project.status !== "active") proj.status = project.status;
  if (project.priority && project.priority !== "medium") proj.priority = project.priority;
  if (project.dueDate) proj.dueDate = project.dueDate;
  proj.columns = columns.map((c) => ({ id: c.id, name: c.name, type: c.type }));
  return {
    project: proj,
    noteCount: notes.length,
    pinnedNotes,
    openTasks: openCards,
    recentActivity,
  };
}

export function executeSearchNotes(snap: CairnSnapshot, args: Args): unknown {
  const { query, projectId, limit = 10 } = args;
  const qr = String(query).toLowerCase();
  return snap.notes
    .filter((n) => {
      if (n.archivedAt) return false;
      if (projectId && n.projectId !== projectId) return false;
      return n.title.toLowerCase().includes(qr) || n.contentText.toLowerCase().includes(qr);
    })
    .slice(0, limit)
    .map((n) => ({
      id: n.id,
      title: n.title,
      snippet: n.contentText.slice(0, 120),
      projectId: n.projectId,
      folder: n.folder ?? "",
      updatedAt: n.updatedAt,
    }));
}

export function executeSearchTasks(snap: CairnSnapshot, args: Args): unknown {
  const { query, projectId, columnType, limit = 10 } = args;
  const qr = String(query).toLowerCase();
  return snap.cards
    .filter((c) => {
      if (c.archivedAt) return false;
      if (projectId && c.projectId !== projectId) return false;
      if (columnType) {
        const col = snap.columns.find((col) => col.id === c.columnId);
        if (!col || col.type !== columnType) return false;
      }
      return c.title.toLowerCase().includes(qr) || (c.description && c.description.toLowerCase().includes(qr));
    })
    .slice(0, limit)
    .map((c) => {
      const col = snap.columns.find((col) => col.id === c.columnId);
      const limitVal = 400;
      const desc = c.description ?? "";
      const truncated = desc.length > limitVal
        ? desc.slice(0, limitVal) + "\n... (description truncated, use get_task to read full description)"
        : (c.description ?? null);
      const out: Record<string, unknown> = {
        id: c.id,
        title: c.title,
        columnId: c.columnId,
        columnName: col?.name ?? "Unknown",
        columnType: col?.type ?? "custom",
        priority: c.priority,
        projectId: c.projectId,
      };
      if (truncated !== null) out.description = truncated;
      if (c.dueDate) out.dueDate = c.dueDate;
      return out;
    });
}
