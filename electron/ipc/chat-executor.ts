/**
 * Cairn — Tool executor for the AI chat loop
 *
 * Implements the `executeTool` function that handles each AI tool call,
 * dispatching to DB queries, file operations, and other helpers.
 */

import type Database from "better-sqlite3";
import type { BrowserWindow } from "electron";
import path from "path";
import fs from "fs";
import dagre from "@dagrejs/dagre";
import * as q from "../db/queries";
import { writeNoteFile, deleteNoteFile, stripMarkdown } from "../notes-files";
import { buildContextResponse } from "../lib/context";
import { generatePrd } from "../lib/prd";
import { executeReadTool, type CairnSnapshot } from "../lib/read-tools";
import { DEFAULT_COLUMNS } from "../db/defaults";
import { newId, ts } from "../db/utils";
import { callLLM, type LLMConfig } from "../lib/llm";
import { TOOL_LABELS, type ChatRequest, type ToolArgs } from "../lib/tools";
import { getKnowledgeGraph, getNeighbours } from "../db/graph-queries";
import type { GraphFilters, EdgeType } from "../db/graph-queries";
import { aiWriteLock } from "../lib/ai-write-lock";

// ── Static reference constants (returned by get_dashboard_constants / get_idea_flow_rules) ──

const DASHBOARD_CONSTANTS = {
  description: "window.cairn API for Cairn dashboards (rendered in a sandboxed iframe).",
  rules: [
    "html must be a complete self-contained document with inline CSS/JS only — no external URLs",
    "Never hardcode projectId or workspaceId — always use window.cairn.projectId and window.cairn.workspaceId",
    "Always fetch data dynamically via helpers — never bake in static data",
  ],
  helpers: {
    "window.cairn.projectId": "Active project ID (string)",
    "window.cairn.workspaceId": "Active workspace ID (string)",
    "window.cairn.getProjectSummary(projectId?)": "Returns { project, noteCount, totalCards, columns: [{ id, name, type, taskCount, tasks: [{ id, title, priority, dueDate }] }] }",
    "window.cairn.listTasks(projectId?)": "Returns { tasksByColumn: { COLUMN_ID: [{ id, title, priority, description, dueDate, columnId, columnName, columnType, updatedAt }] } }. Usage: Object.values(result.tasksByColumn).flat()",
    "window.cairn.listNotes(projectId?)": "Returns [{ id, title, projectId, isPinned, updatedAt }]",
    "window.cairn.listRecentActivity(opts?)": "Returns { recentNotes: [{ id, title, projectId, updatedAt }], recentTasks: [{ id, title, projectId, updatedAt }] }",
    "window.cairn.searchTasks(query, projectId?)": "Returns [{ id, title, priority, columnId }]",
    "window.cairn.searchNotes(query, projectId?)": "Returns [{ id, title, snippet, projectId }]",
    "window.cairn.getContext()": "Returns { workspaces, projects: [{ id, name, status, priority, columns: [{ id, name, type }] }] }",
  },
};

const IDEA_FLOW_RULES = {
  description: "Idea Flow node types, data shapes, and group conventions.",
  nodeTypes: {
    idea:        "Free-form thought. data: { title, body }",
    note_ref:    "Links to an existing note. data: { noteId }",
    task_ref:    "Links to an existing task card. data: { cardId }",
    url:         "External reference. data: { url, title?, description? }",
    ai_summary:  "AI-generated summary. data: { content }. Do not connect edges TO this from other ai_summary nodes.",
    group:       "Spatial container. data: { label?, color? }. Do NOT connect edges to/from group nodes.",
  },
  positioning: [
    "Always call get_idea_flow first — use spatial.nextPosition as the base {x,y} for new nodes, incrementing y by ~120px per row",
    "get_idea_flow returns absoluteX/absoluteY on every node for full canvas reasoning",
  ],
  groups: [
    "Create the group node first, then create child nodes with parentId set to the group's ID",
    "Child coordinates are relative to the group's top-left corner — use spatial.groupSlots[groupId] as starting position, increment y ~100px per row",
    "layout_idea_flow runs two-phase: children arranged inside groups first, then groups + ungrouped nodes arranged together",
    "Always call layout_idea_flow after bulk-creating grouped nodes",
  ],
};

export async function executeTool(
  db: Database.Database,
  req: ChatRequest,
  workspacePath: string,
  llmConfig: LLMConfig,
  name: string,
  args: ToolArgs,
  emit?: (event: { tool: string; label: string; args: Record<string, unknown> }) => void,
  getWin?: () => BrowserWindow | null,
): Promise<unknown> {
  emit?.({ tool: name, label: TOOL_LABELS[name]?.(args) ?? name, args });
  const snap = q.getFullSnapshot(db) as CairnSnapshot;

  // ── Shared read tools (also used by db:mcpQuery and MCP server) ──────────
  {
    const res = executeReadTool(db, snap, name, args);
    if (res.handled) return res.result;
  }

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

      const tags = snap.tags.map((t) => ({ id: t.id, name: t.name, color: t.color }));

      return {
        workspace: workspace ? { workspaceId: workspace.id, name: workspace.name } : null,
        activeProject: project ? { projectId: project.id, name: project.name, status: project.status } : null,
        allProjects,
        columns,
        recentNotes,
        recentTasks,
        tags,
      };
    }
    case "get_note": {
      const note = snap.notes.find((n) => n.id === args.noteId);
      if (!note) return { error: "Note not found" };
      return {
        id: note.id, title: note.title, content: note.content,
        projectId: note.projectId, isPinned: note.isPinned,
        linkedNoteIds: note.linkedNoteIds, linkedCardIds: note.linkedCardIds,
        updatedAt: note.updatedAt, version: note.version ?? 0,
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
    case "get_dashboard_constants":
      return DASHBOARD_CONSTANTS;
    case "get_idea_flow_rules":
      return IDEA_FLOW_RULES;
    case "create_note": {
      const project = snap.projects.find((p) => p.id === args.projectId);
      if (!project) return { error: "Project not found" };
      const noteId = newId();
      const markdown = (args.content as string) ?? "";
      const folder = typeof args.folder === "string" ? args.folder : "";
      const win = getWin?.() ?? null;
      aiWriteLock.lock(noteId, win);
      try {
        const note = q.createNote(db, {
          id: noteId, projectId: args.projectId, workspaceId: project.workspaceId,
          title: args.title, content: markdown, contentText: stripMarkdown(markdown),
          tagIds: Array.isArray(args.tagIds) ? args.tagIds as string[] : undefined,
          folder,
        });
        writeNoteFile(workspacePath, { ...note, projectName: project.name });
        return note;
      } finally {
        aiWriteLock.unlock(noteId, win);
      }
    }
    case "import_note_from_file": {
      const project = snap.projects.find((p) => p.id === args.projectId);
      if (!project) return { error: "Project not found" };
      const resolvedPath = path.resolve(args.filePath as string);
      if (!fs.existsSync(resolvedPath)) return { error: `File not found: ${resolvedPath}` };
      let markdown: string;
      try {
        markdown = fs.readFileSync(resolvedPath, "utf8");
      } catch (e) {
        return { error: `Cannot read file: ${(e as Error).message}` };
      }
      const title = (args.title as string | undefined)
        ?? path.basename(resolvedPath).replace(/\.[^/.]+$/, "");
      const noteId = newId();
      const note = q.createNote(db, {
        id: noteId, projectId: args.projectId as string, workspaceId: project.workspaceId,
        title, content: markdown, contentText: stripMarkdown(markdown),
        tagIds: Array.isArray(args.tagIds) ? args.tagIds as string[] : undefined,
      });
      writeNoteFile(workspacePath, { ...note, projectName: project.name });
      return { ...note, importedFrom: resolvedPath };
    }
    case "resolve_project": {
      const candidates = snap.projects.filter((p) =>
        !p.archivedAt && (!args.workspaceId || p.workspaceId === args.workspaceId)
      );
      const needle = (args.name as string).toLowerCase().trim();
      let match = candidates.find((p) => p.name.toLowerCase() === needle);
      if (!match) match = candidates.find((p) => p.name.toLowerCase().startsWith(needle));
      if (!match) match = candidates.find((p) => p.name.toLowerCase().includes(needle));
      if (!match) return { error: `No project found matching "${args.name}"`, candidates: candidates.map((p) => ({ id: p.id, name: p.name })) };
      const columns = snap.columns
        .filter((c) => c.projectId === match!.id)
        .sort((a, b) => a.order - b.order)
        .map((c) => ({ id: c.id, name: c.name, type: c.type }));
      return { id: match.id, name: match.name, workspaceId: match.workspaceId, status: match.status, columns };
    }
    case "ensure_note": {
      const project = snap.projects.find((p) => p.id === args.projectId);
      if (!project) return { error: "Project not found" };
      const existing = snap.notes.find(
        (n) => !n.archivedAt && n.projectId === args.projectId && n.title === args.title
      );
      const markdown = (args.content as string | undefined) ?? "";
      const ensureTagIds = Array.isArray(args.tagIds) ? args.tagIds as string[] : undefined;
      const ensureIsPinned = typeof args.isPinned === "boolean" ? args.isPinned : undefined;
      const ensureFolder = typeof args.folder === "string" ? args.folder : undefined;
      const ensureNoteId = existing?.id ?? newId();
      const win = getWin?.() ?? null;
      aiWriteLock.lock(ensureNoteId, win);
      try {
        if (existing) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const patch: Record<string, any> = { content: markdown, contentText: stripMarkdown(markdown) };
          if (ensureTagIds !== undefined) patch.tagIds = ensureTagIds;
          if (ensureIsPinned !== undefined) patch.isPinned = ensureIsPinned;
          if (ensureFolder !== undefined) patch.folder = ensureFolder;
          const note = q.updateNote(db, existing.id, patch);
          writeNoteFile(workspacePath, { ...note, projectName: project.name });
          return { id: existing.id, title: existing.title, action: "updated", updatedAt: note.updatedAt };
        } else {
          const note = q.createNote(db, {
            id: ensureNoteId, projectId: args.projectId as string, workspaceId: project.workspaceId,
            title: args.title as string, content: markdown, contentText: stripMarkdown(markdown),
            tagIds: ensureTagIds,
            isPinned: ensureIsPinned,
            folder: ensureFolder ?? "",
          });
          writeNoteFile(workspacePath, { ...note, projectName: project.name });
          return { id: ensureNoteId, title: args.title, action: "created", createdAt: note.createdAt };
        }
      } finally {
        aiWriteLock.unlock(ensureNoteId, win);
      }
    }
    case "append_to_note": {
      const note = snap.notes.find((n) => n.id === args.noteId);
      if (!note) return { error: "Note not found" };
      const appendNoteId = args.noteId as string;
      const win = getWin?.() ?? null;
      aiWriteLock.lock(appendNoteId, win);
      try {
        const separator = (args.separator as string | undefined) ?? "\n\n";
        const existing = note.content ?? "";
        const newContent = existing ? existing + separator + (args.content as string) : (args.content as string);
        const updated = q.updateNote(db, appendNoteId, { content: newContent, contentText: stripMarkdown(newContent) });
        const proj = snap.projects.find((p) => p.id === note.projectId);
        writeNoteFile(workspacePath, { ...updated, projectName: proj?.name ?? note.projectId });
        return { id: note.id, title: note.title, updatedAt: updated.updatedAt, newLength: newContent.length };
      } finally {
        aiWriteLock.unlock(appendNoteId, win);
      }
    }
    case "patch_note": {
      const existing = snap.notes.find((n) => n.id === args.noteId);
      if (!existing) return { error: "Note not found" };
      const patchNoteId = args.noteId as string;
      const oldStr = args.oldString as string;
      const newStr = args.newString as string;
      const all = (args.replaceAll as boolean | undefined) ?? false;
      const currentContent = existing.content ?? "";
      const count = currentContent.split(oldStr).length - 1;
      if (count === 0) return { error: "oldString not found in note content" };
      if (count > 1 && !all) return { error: `oldString matches ${count} times — set replaceAll: true to replace all, or provide more surrounding context to make it unique` };
      const newContent = all ? currentContent.split(oldStr).join(newStr) : currentContent.replace(oldStr, newStr);
      const win = getWin?.() ?? null;
      aiWriteLock.lock(patchNoteId, win);
      try {
        const note = q.updateNote(db, patchNoteId, { content: newContent, contentText: stripMarkdown(newContent) });
        const proj = snap.projects.find((p) => p.id === existing.projectId);
        writeNoteFile(workspacePath, { ...note, projectName: proj?.name ?? existing.projectId });
        return { id: existing.id, title: existing.title, updatedAt: note.updatedAt, replacements: all ? count : 1 };
      } finally {
        aiWriteLock.unlock(patchNoteId, win);
      }
    }
    case "update_note": {
      const existing = snap.notes.find((n) => n.id === args.noteId);
      if (!existing) return { error: "Note not found" };
      const updateNoteId = args.noteId as string;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const patch: Record<string, any> = {};
      if (args.title !== undefined && args.title !== "") patch.title = args.title as string;
      if (args.content !== undefined) {
        patch.content = args.content as string;
        patch.contentText = stripMarkdown(args.content as string);
      }
      if (args.isPinned !== undefined) patch.isPinned = args.isPinned as boolean;
      if (Array.isArray(args.tagIds)) patch.tagIds = args.tagIds as string[];
      const win = getWin?.() ?? null;
      aiWriteLock.lock(updateNoteId, win);
      try {
        const note = q.updateNote(db, updateNoteId, patch);
        const proj = snap.projects.find((p) => p.id === note.projectId);
        writeNoteFile(workspacePath, { ...note, projectName: proj?.name ?? note.projectId });
        return note;
      } finally {
        aiWriteLock.unlock(updateNoteId, win);
      }
    }
    case "move_note": {
      const note = snap.notes.find((n) => n.id === args.noteId);
      if (!note) return { error: "Note not found" };
      const targetProject = snap.projects.find((p) => p.id === args.targetProjectId);
      if (!targetProject) return { error: "Target project not found" };
      if (note.projectId === args.targetProjectId) return { error: "Note is already in that project" };
      const sourceProject = snap.projects.find((p) => p.id === note.projectId);
      // Delete .md from source project folder
      deleteNoteFile(workspacePath, sourceProject?.name ?? note.projectId, note.id);
      // updateNote doesn't accept projectId — use a targeted SQL update
      db.prepare(`UPDATE notes SET project_id = ?, workspace_id = ?, updated_at = ? WHERE id = ?`)
        .run(targetProject.id, targetProject.workspaceId, ts(), note.id);
      const moved = q.getNoteById(db, note.id)!;
      // Write .md to target project folder
      writeNoteFile(workspacePath, { ...moved, projectName: targetProject.name });
      return { id: moved.id, title: moved.title, previousProjectId: note.projectId, newProjectId: targetProject.id };
    }
    case "create_task": {
      const col = snap.columns.find((c) => c.id === args.columnId);
      if (!col) return { error: "Column not found" };
      const title = (args.title as string | null | undefined)?.trim();
      if (!title) return { error: "Task title is required" };
      const cardId = newId();
      // Query live count so concurrent creates in the same round get unique order values
      const order = q.getCards(db, { columnId: args.columnId as string }).length;
      return q.createCard(db, {
        id: cardId, columnId: args.columnId, projectId: args.projectId,
        workspaceId: col.workspaceId, title,
        description: args.description ?? null, priority: args.priority ?? "medium",
        dueDate: undefined, order,
        tagIds: Array.isArray(args.tagIds) ? args.tagIds as string[] : undefined,
      });
    }
    case "update_task_status": {
      const card = snap.cards.find((c) => c.id === args.cardId);
      if (!card) return { error: "Task not found" };
      const col = snap.columns.find((c) => c.id === args.targetColumnId);
      if (!col) return { error: "Column not found" };
      const result = q.updateCard(db, args.cardId as string, { columnId: args.targetColumnId as string });
      // When moving to done, clear this card from every other task's blocked_by_ids
      if (col.type === "done") q.clearBlockersFromAll(db, [args.cardId as string]);
      return result;
    }
    case "bulk_update_task_status": {
      const col = snap.columns.find((c) => c.id === args.targetColumnId);
      if (!col) return { error: "Column not found" };
      const cardIds = args.cardIds as string[];
      if (!Array.isArray(cardIds) || cardIds.length === 0) return { error: "cardIds must be a non-empty array" };
      const results: Array<{ id: string; ok: boolean; error?: string }> = [];
      const movedIds: string[] = [];
      for (const cardId of cardIds) {
        const exists = snap.cards.find((c) => c.id === cardId);
        if (!exists) {
          results.push({ id: cardId, ok: false, error: "Task not found" });
        } else {
          q.updateCard(db, cardId, { columnId: args.targetColumnId as string });
          results.push({ id: cardId, ok: true });
          movedIds.push(cardId);
        }
      }
      // When moving to done, clear all moved card IDs from every other task's blocked_by_ids
      if (col.type === "done") q.clearBlockersFromAll(db, movedIds);
      const moved = results.filter((r) => r.ok).length;
      const failed = results.filter((r) => !r.ok);
      return { moved, failed, targetColumnId: args.targetColumnId, targetColumnName: col.name };
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
        linkedNoteIds: card.linkedNoteIds, blockedByIds: card.blockedByIds ?? [],
        projectId: card.projectId, createdAt: card.createdAt, updatedAt: card.updatedAt, version: card.version ?? 0,
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
    case "ask_questions": {
      // Renderer-only tool — the modal intercepts the tool-call event and
      // renders an inline question form. The executor just acknowledges so the
      // tool loop can continue after the user submits answers.
      return { ok: true, questions: args.questions };
    }
    case "suggest_connections": {
      // Renderer-only tool — the Graph AI panel intercepts the tool-call event
      // and renders each action as an interactive card with an Apply button.
      // The executor just acknowledges so streaming can continue.
      return { ok: true, count: (args.actions as unknown[])?.length ?? 0 };
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
      let orderOffset = 0;
      for (let i = 0; i < tasks.length; i++) {
        const task = tasks[i];
        const taskTitle = (task.title as string | null | undefined)?.trim();
        if (!taskTitle) continue; // skip AI-generated tasks with missing/empty titles
        const cardId = newId();
        emit?.({ tool: "create_task", label: `Creating task "${taskTitle}"`, args: { title: taskTitle } });
        const card = q.createCard(db, {
          id: cardId, columnId: args.columnId as string,
          projectId: col.projectId, workspaceId: col.workspaceId,
          title: taskTitle, description: task.description?.trim() || null,
          priority: task.priority ?? "medium",
          order: existingCount + orderOffset,
        });
        orderOffset++;
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

    case "block_task": {
      const card    = snap.cards.find((c) => c.id === args.cardId);
      const blocker = snap.cards.find((c) => c.id === args.blockerCardId);
      if (!card)    return { error: "Task not found" };
      if (!blocker) return { error: "Blocker task not found" };
      if (card.projectId !== blocker.projectId) return { error: "Cards must be in the same project" };
      if (args.cardId === args.blockerCardId)   return { error: "A card cannot block itself" };
      // Circular dep check using live snap data
      const projectCards = snap.cards.filter((c) => c.projectId === card.projectId);
      const cardMap = new Map(projectCards.map((c) => [c.id, c]));
      function canReach(from: string, target: string, visited = new Set<string>()): boolean {
        if (from === target) return true;
        if (visited.has(from)) return false;
        visited.add(from);
        const node = cardMap.get(from);
        if (!node) return false;
        return node.blockedByIds.some((bid) => canReach(bid, target, visited));
      }
      if (canReach(args.blockerCardId as string, args.cardId as string, new Set())) {
        return { error: "Circular dependency detected" };
      }
      return q.addCardBlocker(db, args.cardId as string, args.blockerCardId as string);
    }

    case "unblock_task": {
      const card = snap.cards.find((c) => c.id === args.cardId);
      if (!card) return { error: "Task not found" };
      return q.removeCardBlocker(db, args.cardId as string, args.blockerCardId as string);
    }

    case "list_ready_tasks": {
      return q.getReadyCards(db, args.projectId as string | undefined);
    }

    case "archive_task": {
      const card = snap.cards.find((c) => c.id === args.cardId);
      if (!card) return { error: "Task not found" };
      if (card.archivedAt) return { error: "Task is already archived" };
      const archivedAt = new Date().toISOString();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return q.updateCard(db, args.cardId as string, { archivedAt } as any);
    }

    case "restore_task": {
      // Must query DB directly — archived cards are filtered out of snap.cards
      const row = q.getCardById(db, args.cardId as string);
      if (!row) return { error: "Task not found" };
      if (!row.archivedAt) return { error: "Task is not archived" };
      return q.restoreCard(db, args.cardId as string);
    }

    case "update_project": {
      const project = snap.projects.find((p) => p.id === args.projectId);
      if (!project) return { error: "Project not found" };
      const patch: Record<string, unknown> = {};
      if (args.name !== undefined)        patch.name        = args.name;
      if (args.description !== undefined) patch.description = args.description;
      if (args.icon !== undefined)        patch.icon        = args.icon;
      if (args.status !== undefined)      patch.status      = args.status;
      if (args.priority !== undefined)    patch.priority    = args.priority;
      if (args.dueDate !== undefined)     patch.dueDate     = args.dueDate || undefined;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return q.updateProject(db, args.projectId as string, patch as any);
    }
    case "delete_project": {
      const project = snap.projects.find((p) => p.id === args.projectId);
      if (!project) return { error: "Project not found" };
      const { deleteProjectNotesDir } = await import("../notes-files");
      deleteProjectNotesDir(workspacePath, project.name);
      q.deleteProject(db, args.projectId as string);
      return { deleted: true, id: args.projectId, name: project.name };
    }
    // ── Idea Flow tools ──────────────────────────────────────────────────────

    case "get_idea_flow": {
      const project = snap.projects.find((p) => p.id === args.projectId);
      if (!project) return { error: "Project not found" };
      return q.getResolvedFlow(db, args.projectId as string);
    }

    case "create_idea_flow_node": {
      const project = snap.projects.find((p) => p.id === args.projectId);
      if (!project) return { error: "Project not found" };
      const validTypes = ["idea", "note_ref", "task_ref", "group", "url", "ai_summary"];
      if (!validTypes.includes(args.type as string)) return { error: `Invalid node type. Must be one of: ${validTypes.join(", ")}` };
      const flow = q.getOrCreateFlow(db, args.projectId as string);
      const nodeId = newId();
      const node = q.createFlowNode(db, {
        id: nodeId,
        flowId: flow.id,
        type: args.type as string,
        x: (args.x as number) ?? 0,
        y: (args.y as number) ?? 0,
        width: args.width as number | undefined,
        height: args.height as number | undefined,
        parentId: args.parentId as string | undefined,
        data: (args.data as Record<string, unknown>) ?? {},
      });
      // Optionally create edges inline
      const createdEdges: { id: string; source: string; target: string; label: string | null }[] = [];
      if (Array.isArray(args.edges)) {
        for (const edgeDef of args.edges as Array<{ targetNodeId?: string; sourceNodeId?: string; label?: string }>) {
          const edgeId = newId();
          const src = edgeDef.sourceNodeId ?? nodeId;
          const tgt = edgeDef.targetNodeId ?? nodeId;
          const edge = q.createFlowEdge(db, { id: edgeId, flowId: flow.id, sourceNodeId: src, targetNodeId: tgt, label: edgeDef.label });
          if (edge) createdEdges.push({ id: edge.id, source: src, target: tgt, label: edgeDef.label ?? null });
        }
      }
      return { ...node, edges: createdEdges };
    }

    case "update_idea_flow_node": {
      try {
        return q.updateFlowNode(db, args.nodeId as string, {
          x: args.x as number | undefined,
          y: args.y as number | undefined,
          width: args.width as number | undefined,
          height: args.height as number | undefined,
          data: args.data as Record<string, unknown> | undefined,
        });
      } catch (err) {
        return { error: (err as Error).message };
      }
    }

    case "delete_idea_flow_node": {
      const nodes = db.prepare("SELECT id FROM idea_flow_nodes WHERE id = ?").get(args.nodeId as string);
      if (!nodes) return { error: "Node not found" };
      q.deleteFlowNode(db, args.nodeId as string);
      return { deleted: true, id: args.nodeId };
    }

    case "create_idea_flow_edge": {
      const srcNodeRow = db.prepare("SELECT id, flow_id FROM idea_flow_nodes WHERE id = ?")
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .get(args.sourceNodeId as string) as any;
      if (!srcNodeRow) return { error: "Source node not found" };
      const tgtNodeRow = db.prepare("SELECT id FROM idea_flow_nodes WHERE id = ?")
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .get(args.targetNodeId as string) as any;
      if (!tgtNodeRow) return { error: "Target node not found" };
      const edgeId = newId();
      return q.createFlowEdge(db, {
        id: edgeId,
        flowId: srcNodeRow.flow_id as string,
        sourceNodeId: args.sourceNodeId as string,
        targetNodeId: args.targetNodeId as string,
        label: args.label as string | undefined,
      });
    }

    case "delete_idea_flow_edge": {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const edgeRow = db.prepare("SELECT id FROM idea_flow_edges WHERE id = ?").get(args.edgeId as string) as any;
      if (!edgeRow) return { error: "Edge not found" };
      q.deleteFlowEdge(db, args.edgeId as string);
      return { deleted: true, id: args.edgeId };
    }

    case "layout_idea_flow": {
      const project = snap.projects.find((p) => p.id === args.projectId);
      if (!project) return { error: "Project not found" };
      const flow = q.getOrCreateFlow(db, args.projectId as string);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rawNodes = db.prepare("SELECT * FROM idea_flow_nodes WHERE flow_id = ?").all(flow.id) as any[];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rawEdges = db.prepare("SELECT * FROM idea_flow_edges WHERE flow_id = ?").all(flow.id) as any[];
      if (rawNodes.length === 0) return { arranged: 0 };

      const dir = (args.direction as string) === "TB" ? "TB" : "LR";
      const NODE_W = 220, NODE_H = 80, GROUP_PADDING = 48, GROUP_PADDING_TOP = 56, GROUP_GAP = 80;

      function makeG(rankdir: string, nodesep: number, ranksep: number) {
        const g = new dagre.graphlib.Graph();
        g.setDefaultEdgeLabel(() => ({}));
        g.setGraph({ rankdir, nodesep, ranksep, marginx: 40, marginy: 40 });
        return g;
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const groups    = rawNodes.filter((n: any) => n.type === "group");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ungrouped = rawNodes.filter((n: any) => n.type !== "group" && !n.parent_id);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const grouped   = rawNodes.filter((n: any) => n.type !== "group" && !!n.parent_id);

      const now = ts();
      const posStmt  = db.prepare("UPDATE idea_flow_nodes SET x = ?, y = ?, updated_at = ? WHERE id = ?");
      const sizeStmt = db.prepare("UPDATE idea_flow_nodes SET x = ?, y = ?, width = ?, height = ?, updated_at = ? WHERE id = ?");
      const groupSizes = new Map<string, { width: number; height: number }>();

      // Phase 1: layout children inside each group
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const group of groups as any[]) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const children = (grouped as any[]).filter((n: any) => n.parent_id === group.id);
        if (children.length === 0) {
          groupSizes.set(group.id, { width: group.width ?? 320, height: group.height ?? 200 });
          continue;
        }
        const childIds = new Set(children.map((n: { id: string }) => n.id));
        const g = makeG(dir, 60, 120);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        for (const c of children as any[]) g.setNode(c.id, { width: NODE_W, height: NODE_H });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        for (const e of rawEdges as any[]) {
          if (e.source_node_id !== e.target_node_id && childIds.has(e.source_node_id) && childIds.has(e.target_node_id)) {
            g.setEdge(e.source_node_id, e.target_node_id);
          }
        }
        dagre.layout(g);
        let innerMaxX = 0, innerMaxY = 0;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        for (const c of children as any[]) {
          const pos = g.node(c.id);
          if (!pos) continue;
          const rx = pos.x - pos.width / 2 + GROUP_PADDING;
          const ry = pos.y - pos.height / 2 + GROUP_PADDING_TOP;
          innerMaxX = Math.max(innerMaxX, rx + pos.width);
          innerMaxY = Math.max(innerMaxY, ry + pos.height);
          posStmt.run(rx, ry, now, c.id);
        }
        const gw = innerMaxX + GROUP_PADDING;
        const gh = innerMaxY + GROUP_PADDING;
        groupSizes.set(group.id, { width: gw, height: gh });
      }

      // Phase 2: layout groups + ungrouped together
      const topLevel = [...groups, ...ungrouped];
      if (topLevel.length > 0) {
        const g = makeG(dir, GROUP_GAP, GROUP_GAP + 40);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        for (const n of topLevel as any[]) {
          const size = groupSizes.get(n.id);
          g.setNode(n.id, { width: size?.width ?? NODE_W, height: size?.height ?? NODE_H });
        }
        const topIds = new Set(topLevel.map((n: { id: string }) => n.id));
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        for (const e of rawEdges as any[]) {
          if (e.source_node_id !== e.target_node_id && topIds.has(e.source_node_id) && topIds.has(e.target_node_id)) {
            g.setEdge(e.source_node_id, e.target_node_id);
          }
        }
        dagre.layout(g);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        for (const n of topLevel as any[]) {
          const pos = g.node(n.id);
          if (!pos) continue;
          const x = pos.x - pos.width / 2;
          const y = pos.y - pos.height / 2;
          if (n.type === "group") {
            const size = groupSizes.get(n.id)!;
            sizeStmt.run(x, y, size.width, size.height, now, n.id);
          } else {
            posStmt.run(x, y, now, n.id);
          }
        }
      }

      return { arranged: rawNodes.length, direction: dir };
    }

    case "create_tag": {
      const { workspaceId, name, color } = args;
      if (!workspaceId || !name) return { error: "workspaceId and name are required" };
      const tagId = newId();
      const tag = q.createTag(db, { id: tagId, workspaceId: workspaceId as string, name: name as string, color: (color as string) ?? "#6366f1" });
      return { id: tag.id, workspaceId: tag.workspaceId, name: tag.name, color: tag.color };
    }

    case "get_knowledge_graph": {
      const workspaceId = args.workspaceId as string;
      if (!workspaceId) return { error: "workspaceId is required" };
      const filters: GraphFilters = {
        projectIds: Array.isArray(args.projectIds) ? args.projectIds as string[] : [],
        includeAuto: args.includeAuto !== false,
        nodeTypes: Array.isArray(args.nodeTypes) ? args.nodeTypes as GraphFilters["nodeTypes"] : undefined as unknown as GraphFilters["nodeTypes"],
        edgeTypes: Array.isArray(args.edgeTypes) ? args.edgeTypes as EdgeType[] : undefined as unknown as EdgeType[],
      };
      return getKnowledgeGraph(db, workspaceId, filters);
    }

    case "get_neighbors": {
      const workspaceId = args.workspaceId as string;
      const nodeId = args.nodeId as string;
      if (!workspaceId || !nodeId) return { error: "workspaceId and nodeId are required" };
      const depth = typeof args.depth === "number" ? Math.min(3, Math.max(1, args.depth)) : 1;
      const edgeTypes = Array.isArray(args.edgeTypes) ? args.edgeTypes as EdgeType[] : undefined;
      return getNeighbours(db, workspaceId, nodeId, depth, edgeTypes);
    }

    default:
      return { error: `Unknown tool: ${name}` };
  }
}
