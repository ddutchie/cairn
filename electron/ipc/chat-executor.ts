/**
 * Cairn — Tool executor for the AI chat loop
 *
 * Implements the `executeTool` function that handles each AI tool call,
 * dispatching to DB queries, file operations, and other helpers.
 */

import type Database from "better-sqlite3";
import * as q from "../db/queries";
import { writeNoteFile, deleteNoteFile, stripMarkdown } from "../notes-files";
import { buildContextResponse } from "../lib/context";
import { generatePrd } from "../lib/prd";
import { DEFAULT_COLUMNS } from "../db/defaults";
import { newId, ts } from "../db/utils";
import { callLLM, type LLMConfig } from "../lib/llm";
import { TOOL_LABELS, type ChatRequest, type ToolArgs } from "../lib/tools";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function executeTool(
  db: Database.Database,
  req: ChatRequest,
  workspacePath: string,
  llmConfig: LLMConfig,
  name: string,
  args: ToolArgs,
  emit?: (event: { tool: string; label: string; args: Record<string, unknown> }) => void,
): Promise<unknown> {
  emit?.({ tool: name, label: TOOL_LABELS[name]?.(args) ?? name, args });
  const snap = q.getFullSnapshot(db);
  const now = ts();

  switch (name) {
    case "get_cairn_context": {
      return buildContextResponse(db);
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
      return q.searchNotes(db, { query: args.query as string, projectId: args.projectId as string | undefined, limit: args.limit as number | undefined })
        .map((n) => ({ id: n.id, title: n.title, snippet: n.contentText.slice(0, 200), projectId: n.projectId }));
    }
    case "search_tasks": {
      return q.searchTasks(db, { query: args.query as string, projectId: args.projectId as string | undefined, limit: args.limit as number | undefined })
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
      const columns = DEFAULT_COLUMNS.map((col) =>
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
      return generatePrd(db, workspacePath, {
        projectId: args.projectId as string,
        title: args.title as string,
        requirements: args.requirements as string,
      }, llmConfig);
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
      const card = snap.cards.find((c) => c.id === args.cardId);
      if (!card) return { error: "Task not found" };
      const patch: Record<string, unknown> = {};
      if (args.title !== undefined)       patch.title       = args.title;
      if (args.description !== undefined) patch.description = args.description;
      if (args.priority !== undefined)    patch.priority    = args.priority;
      if (args.dueDate !== undefined)     patch.dueDate     = args.dueDate || undefined;
      if (args.columnId !== undefined)    patch.columnId    = args.columnId;
      if (args.assignee !== undefined)    patch.assignee    = args.assignee || undefined;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return q.updateCard(db, args.cardId as string, patch as any);
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
