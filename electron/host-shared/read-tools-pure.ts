/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Cairn — Shared read-only tool pure logic (snapshot-based)
 * No native or database dependencies — can be imported in any context
 * (including Electron main process, IPC handlers, and standalone MCP server).
 */

import { noteDigest } from "../../shared/notes/toc";
import { buildNoteMarkdown, buildProjectMarkdown } from "../../shared/notes/export";
import type { BoardColumn, TaskCard } from "../../shared/types/board";
import type { Note } from "../../shared/types/notes";
import type { Project, Tag, Workspace } from "../../shared/types/workspace";

/** The entity snapshot the read tools query (`getFullSnapshot` / MCP `getSnapshot`). */
export interface CairnSnapshot {
  workspaces: Workspace[];
  projects: Project[];
  notes: Array<Note & { content: string }>;
  columns: BoardColumn[];
  cards: TaskCard[];
  tags: Tag[];
}

type Args = Record<string, any>;

export function executeGetProjectContextPack(snap: CairnSnapshot, args: Args): unknown {
  const project = snap.projects.find((p) => p.id === args.projectId);
  if (!project) return { error: "Project not found" };
  const columns = snap.columns
    .filter((c) => c.projectId === project.id)
    .sort((a, b) => a.order - b.order);
  const notes = snap.notes.filter((n) => n.projectId === project.id && !n.archivedAt);
  // Cap pinned notes to the most-recent few with a short excerpt — uncapped this
  // was a context-overflow source (1000 chars × unbounded pinned count). The
  // agent reads the rest with get_note. `pinnedNotesTotal` signals there's more.
  const PINNED_CAP = 5;
  const pinnedAll = notes
    .filter((n) => n.isPinned)
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  const pinnedNotes = pinnedAll
    .slice(0, PINNED_CAP)
    .map((n) => ({
      id: n.id,
      title: n.title,
      folder: n.folder ?? "",
      // Outline (headings) when the note is structured — a compact semantic
      // summary; short excerpt otherwise. The agent reads full text via get_note.
      ...noteDigest(n.content ?? "", 300),
    }));
  // Cap open tasks to a total budget across columns with a short description
  // preview; the agent uses get_task for full detail.
  const TASK_CAP = 20;
  const TASK_PREVIEW = 120;
  let taskBudget = TASK_CAP;
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
        .slice(0, Math.max(0, taskBudget))
        .map((c) => {
          taskBudget -= 1;
          const desc = c.description ?? "";
          const truncated = desc.length > TASK_PREVIEW
            ? desc.slice(0, TASK_PREVIEW) + "… (use get_task for full description)"
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
    pinnedNotesTotal: pinnedAll.length,
    openTasks: openCards,
    recentActivity,
  };
}

// ── Export (pure markdown serialisers) ──────────────────────────────────────
// Assemble the platform-neutral export inputs from the snapshot, then delegate
// to the shared builders so desktop + mobile produce identical markdown.

function tagNamesFor(snap: CairnSnapshot, tagIds: string[]): string[] {
  return tagIds
    .map((id) => snap.tags.find((t) => t.id === id)?.name)
    .filter((n): n is string => !!n);
}

/** Serialise a single note to a self-contained markdown document. */
export function serializeNoteMarkdown(snap: CairnSnapshot, noteId: string): { error: string } | { markdown: string; title: string } {
  const note = snap.notes.find((n) => n.id === noteId && !n.archivedAt);
  if (!note) return { error: "Note not found" };
  const markdown = buildNoteMarkdown({
    title: note.title,
    content: note.content,
    tagNames: tagNamesFor(snap, note.tagIds),
    folder: note.folder,
  });
  return { markdown, title: note.title };
}

/**
 * Serialise a whole project — metadata, board grouped by column, and all
 * non-archived notes (folder-sorted) — to one markdown document.
 */
export function serializeProjectMarkdown(snap: CairnSnapshot, projectId: string): { error: string } | { markdown: string; title: string } {
  const project = snap.projects.find((p) => p.id === projectId);
  if (!project) return { error: "Project not found" };

  const columns = snap.columns
    .filter((c) => c.projectId === projectId)
    .sort((a, b) => a.order - b.order)
    .map((col) => ({
      name: col.name,
      cards: snap.cards
        .filter((c) => c.columnId === col.id && !c.archivedAt)
        .sort((a, b) => a.order - b.order)
        .map((c) => ({
          title: c.title,
          description: c.description ?? null,
          priority: c.priority,
          dueDate: c.dueDate ?? null,
          assignee: c.assignee ?? null,
          tagNames: tagNamesFor(snap, c.tagIds),
        })),
    }));

  const notes = snap.notes
    .filter((n) => n.projectId === projectId && !n.archivedAt)
    .sort((a, b) => (a.folder ?? "").localeCompare(b.folder ?? "") || a.title.localeCompare(b.title))
    .map((n) => ({
      title: n.title,
      content: n.content,
      tagNames: tagNamesFor(snap, n.tagIds),
      folder: n.folder,
    }));

  const markdown = buildProjectMarkdown({
    name: project.name,
    description: project.description ?? null,
    status: project.status,
    priority: project.priority,
    dueDate: project.dueDate ?? null,
    columns,
    notes,
  });
  return { markdown, title: project.name };
}
