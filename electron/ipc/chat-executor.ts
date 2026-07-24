/**
 * Cairn — Tool executor for the AI chat loop
 *
 * Implements the `executeTool` function that handles each AI tool call,
 * dispatching to DB queries, file operations, and other helpers.
 */

import type Database from "better-sqlite3";
import type { BrowserWindow } from "electron";
import * as q from "../db/queries";
import { writeNoteFile } from "../notes-files";
import { generatePrd } from "../lib/prd";
import { executeReadTool, type CairnSnapshot } from "../lib/read-tools";
import { newId } from "../db/utils";
import { callLLM, type LLMConfig } from "../lib/llm";
import { TOOL_LABELS, type ChatRequest, type ToolArgs } from "../lib/tools";
import { aiWriteLock } from "../lib/ai-write-lock";
import { executeTool as executeMcpTool } from "../mcp/tools";

// ── Static reference constants (returned by get_dashboard_constants / get_idea_flow_rules) ──

export async function executeTool(
  db: Database.Database,
  req: ChatRequest,
  workspacePath: string,
  llmConfig: LLMConfig,
  name: string,
  args: ToolArgs,
  emit?: (event: { tool: string; label: string; args: Record<string, unknown>; callId?: string }) => void,
  getWin?: () => BrowserWindow | null,
  emitDone?: (event: { tool: string; cairnRef?: { type: "note" | "task"; id: string; title: string }; externalRef?: { url: string; title?: string; snippet?: string }; output?: string; callId?: string }) => void,
  callId?: string,
): Promise<unknown> {
  emit?.({ tool: name, label: TOOL_LABELS[name]?.(args) ?? name, args, callId });
  const snap = q.getFullSnapshot(db) as CairnSnapshot;

  const result = await (async () => {
    // ── Shared read tools (also used by db:mcpQuery and MCP server) ──────────
    {
      const res = executeReadTool(db, snap, name, args);
      if (res.handled) return res.result;
    }

  switch (name) {
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
        .map((n) => ({ noteId: n.id, title: n.title, folder: n.folder ?? "", updatedAt: n.updatedAt }));

      // Include recent tasks per column so task-related queries don't need a separate list_tasks call.
      // `columnName` is intentionally omitted here — the `columns` array above already carries the
      // columnId→name mapping. Tests/assertions only check `columnId` on each recentTasks entry.
      const recentTasks = columns.map((col) => ({
        columnId: col.columnId,
        tasks: snap.cards
          .filter((c) => c.columnId === col.columnId && !c.archivedAt)
          .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
          .slice(0, 5)
          .map((c) => {
            const t: Record<string, unknown> = { taskId: c.id, title: c.title, priority: c.priority };
            if (c.dueDate) t.dueDate = c.dueDate;
            return t;
          }),
      }));

      const allProjects = snap.projects
        .filter((p) => !p.archivedAt)
        .map((p) => {
          // Omit default-status "active" — the agent already sees the enum via
          // get_cairn_context conventions, and most projects are active.
          const out: Record<string, unknown> = { projectId: p.id, name: p.name };
          if (p.status !== "active") out.status = p.status;
          return out;
        });

      const tags = snap.tags.map((t) => ({ id: t.id, name: t.name, color: t.color }));

      // activeProject: drop default `status: "active"` for the same reason as allProjects.
      const activeProjectOut: Record<string, unknown> | null = project
        ? { projectId: project.id, name: project.name }
        : null;
      if (project && project.status !== "active") activeProjectOut!.status = project.status;

      return {
        workspace: workspace ? { workspaceId: workspace.id, name: workspace.name } : null,
        activeProject: activeProjectOut,
        allProjects,
        columns,
        recentNotes,
        recentTasks,
        tags,
      };
    }
    case "get_cairn_context":
    case "get_note":
    case "get_task":
    case "create_dashboard":
    case "update_dashboard":
    case "get_dashboard_constants":
    case "get_idea_flow_rules":
    case "delete_note":
    case "delete_task":
    case "bulk_update_task_status":
    case "link_note_to_task":
    case "unlink_note_from_task":
    case "create_task":
    case "list_ready_tasks":
    case "list_overdue_tasks":
    case "list_tasks_due":
    case "list_folders":
    case "list_templates":
    case "bulk_move_notes":
    case "upsert_project":
    case "delete_project":
    case "create_tag":
    case "tag_task":
    case "get_idea_flow":
    case "create_idea_flow_node":
    case "update_idea_flow_node":
    case "delete_idea_flow_node":
    case "create_idea_flow_edge":
    case "delete_idea_flow_edge":
    case "layout_idea_flow":
    case "get_knowledge_graph":
    case "get_neighbors":
    case "get_semantic_neighbors":
    case "search_notes_semantic":
    case "search_tasks_semantic":
    case "codebase_reindex":
    case "codebase_search_symbols":
    case "codebase_get_symbol_definition":
    case "codebase_get_references":
    case "codebase_get_file_symbols": {
      return executeMcpTool(db, workspacePath, name, args);
    }
    case "ensure_note": {
      // Use the same authoritative live-DB lookup ensure_note uses, so the
      // aiWriteLock id can't diverge from the id the tool actually writes.
      const existing = q.findLiveNoteByTitle(db, args.projectId as string, args.title as string);
      const ensureNoteId = existing?.id ?? newId();
      const win = getWin?.() ?? null;
      aiWriteLock.lock(ensureNoteId, win);
      try {
        return executeMcpTool(db, workspacePath, name, args);
      } finally {
        aiWriteLock.unlock(ensureNoteId, win);
      }
    }
    case "append_to_note": {
      const win = getWin?.() ?? null;
      const noteId = args.noteId as string;
      aiWriteLock.lock(noteId, win);
      try {
        return executeMcpTool(db, workspacePath, name, args);
      } finally {
        aiWriteLock.unlock(noteId, win);
      }
    }
    case "patch_note": {
      const win = getWin?.() ?? null;
      const noteId = args.noteId as string;
      aiWriteLock.lock(noteId, win);
      try {
        return executeMcpTool(db, workspacePath, name, args);
      } finally {
        aiWriteLock.unlock(noteId, win);
      }
    }
    case "rename_note": {
      const win = getWin?.() ?? null;
      const noteId = args.noteId as string;
      aiWriteLock.lock(noteId, win);
      try {
        return executeMcpTool(db, workspacePath, name, args);
      } finally {
        aiWriteLock.unlock(noteId, win);
      }
    }
    case "update_task": {
      return executeMcpTool(db, workspacePath, name, args);
    }
    case "tag_note": {
      const win = getWin?.() ?? null;
      const noteId = args.noteId as string;
      aiWriteLock.lock(noteId, win);
      try {
        return executeMcpTool(db, workspacePath, name, args);
      } finally {
        aiWriteLock.unlock(noteId, win);
      }
    }
    case "instantiate_template": {
      // Creates a fresh note; result carries the new id, but we can't lock a
      // not-yet-created id, so just delegate (createNote handles its own lock).
      return executeMcpTool(db, workspacePath, name, args);
    }
    case "ask_questions": {
      return { ok: true, questions: args.questions };
    }
    case "suggest_connections": {
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
      for (let i = 0; i < tasks.length; i++) {
        const task = tasks[i];
        const taskTitle = (task.title as string | null | undefined)?.trim();
        if (!taskTitle) continue;
        
        const card = executeMcpTool(db, workspacePath, "create_task", {
          columnId: args.columnId,
          projectId: col.projectId,
          title: taskTitle,
          description: task.description?.trim() || null,
          priority: task.priority ?? "medium",
        }) as { id: string; title: string; priority: string };
        
        // Link card → note
        q.updateCard(db, card.id, { linkedNoteIds: [args.noteId as string] });
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
    default:
      return { error: `Unknown tool: ${name}` };
  }
  })();

  // Resolve cairnRef if possible
  let cairnRef: { type: "note" | "task"; id: string; title: string } | undefined = undefined;
  if (result && typeof result === "object" && !("error" in result)) {
    const resObj = result as Record<string, unknown>;
    
    // For note tools, the result contains ID and title.
    const isNote = [
      "get_note", "ensure_note", "patch_note", "append_to_note", "rename_note", "instantiate_template"
    ].includes(name);
    
    // For task tools, the result contains ID and title.
    const isTask = [
      "get_task", "create_task", "update_task"
    ].includes(name);
    
    if (isNote && typeof resObj.id === "string" && typeof resObj.title === "string") {
      cairnRef = { type: "note", id: resObj.id, title: resObj.title };
    } else if (isTask && typeof resObj.id === "string" && typeof resObj.title === "string") {
      cairnRef = { type: "task", id: resObj.id, title: resObj.title };
    }
  }

  if (emitDone) {
    emitDone({ tool: name, cairnRef, output: JSON.stringify(result), callId });
  }

  return result;
}
