/**
 * Cairn — IPC handlers
 *
 * Registered in main.ts via ipcMain.handle(channel, handler).
 * Each handler receives validated args from the renderer and
 * delegates to the SQLite query layer.
 *
 * All handlers return IpcResult<T> = { data: T } | { error: string }.
 * The renderer's ipcAwait helper should check for { error } and surface it.
 *
 * Note handlers additionally write/delete .md files in the workspace folder
 * so the file system stays in sync with SQLite.
 *
 * Channel naming: "db:<entity>:<action>"
 */

import { ipcMain, app, shell, dialog, BrowserWindow, net } from "electron";
import path from "path";
import fs from "fs";
import type Database from "better-sqlite3";
import * as q from "../db/queries";
import { registerChatHandler } from "./chat";
import { writeNoteFile, deleteNoteFile, deleteProjectNotesDir, stripMarkdown, findNoteFilePath } from "../notes-files";
import { checkMigrations, runMigration } from "../migrations";
import { suppressNextChange } from "../file-watcher";
import { buildContextResponse } from "../lib/context";
import { generatePrd } from "../lib/prd";
import { isLocalEndpoint, callLLM, normaliseBaseUrl } from "../lib/llm";
import { executeReadTool } from "../lib/read-tools";
import { readWorkspaceConfig, writeWorkspaceConfig } from "../workspace-config";
import { markMcpNotificationsRead } from "../db/queries";
import { DEFAULT_COLUMNS } from "../db/defaults";
import { getKnowledgeGraph, getNeighbours, computeAutoRelationships, invalidateRelationshipCache } from "../db/graph-queries";
import type { GraphFilters, EdgeType } from "../db/graph-queries";

// ── Result helpers ────────────────────────────────────────────────────────────

function ok<T>(data: T): { data: T } {
  return { data };
}

function err(message: string): { error: string } {
  return { error: message };
}

/**
 * Wrap a synchronous or async handler body in try/catch.
 * Returns { data } on success, { error } on failure.
 */
function handle<T>(fn: () => T | Promise<T>): Promise<{ data: T } | { error: string }> {
  return Promise.resolve()
    .then(() => fn())
    .then(ok)
    .catch((e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[cairn:ipc:error]", msg);
      return err(msg);
    });
}

function getProjectName(db: Database.Database, projectId: string): string {
  const row = db.prepare("SELECT name FROM projects WHERE id = ?").get(projectId) as { name: string } | undefined;
  return row?.name ?? projectId;
}

/** Mutable context swapped in-place by main.ts when the workspace changes. */
export interface DbContext {
  db: Database.Database;
  workspacePath: string;
  /** Returns the current BrowserWindow, or null before it is created. */
  getWin: () => BrowserWindow | null;
}

export function registerIpcHandlers(ctx: DbContext): void {

  // ── Full snapshot (hydrate store on app launch) ───
  ipcMain.handle("db:snapshot", () => handle(() => q.getFullSnapshot(ctx.db)));
  ipcMain.handle("db:hasData", () => handle(() => q.hasData(ctx.db)));

  // ── Dashboard live query bridge ───────────────────
  // Executes read-only MCP-style tool calls from dashboard iframes.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ipcMain.handle("db:mcpQuery", (_e, { tool, args }: { tool: string; args: Record<string, any> }) => {
    return handle(() => {
      if (tool === "get_cairn_context") {
        return buildContextResponse(ctx.db);
      }
      const snap = q.getFullSnapshot(ctx.db);
      const res = executeReadTool(ctx.db, snap, tool, args);
      if (res.handled) return res.result;
      throw new Error(`Unknown or disallowed tool: ${tool}`);
    });
  });

  // ── Workspaces ────────────────────────────────────
  ipcMain.handle("db:workspace:list", () => handle(() => q.getAllWorkspaces(ctx.db)));
  ipcMain.handle("db:workspace:create", (_e, args) => handle(() => q.createWorkspace(ctx.db, args)));
  ipcMain.handle("db:workspace:update", (_e, { id, patch }) => handle(() => q.updateWorkspace(ctx.db, id, patch)));

  // ── Projects ──────────────────────────────────────
  ipcMain.handle("db:project:list", (_e, { workspaceId }) => handle(() => q.getProjects(ctx.db, workspaceId)));
  ipcMain.handle("db:project:create", (_e, args) => handle(() => {
    const project = q.createProject(ctx.db, args);
    // Create default columns atomically in the same handler call
    if (args.withDefaultColumns) {
      const columns = DEFAULT_COLUMNS.map((col) =>
        q.createColumn(ctx.db, {
          id: q.generateId(),
          projectId: project.id,
          workspaceId: project.workspaceId,
          name: col.name,
          type: col.type,
          order: col.order,
        })
      );
      return { project, columns };
    }
    return { project, columns: [] };
  }));
  ipcMain.handle("db:project:update", (_e, { id, patch }) => handle(() => q.updateProject(ctx.db, id, patch)));
  ipcMain.handle("db:project:delete", (_e, { id }) => handle(() => {
    const project = q.getProjectById(ctx.db, id);
    if (project) {
      deleteProjectNotesDir(ctx.workspacePath, project.name);
    }
    q.deleteProject(ctx.db, id);
  }));

  // ── Notes ─────────────────────────────────────────
  // All note mutations also write/update/delete the corresponding .md file.

  ipcMain.handle("db:note:list", (_e, { projectId }) => handle(() => q.getNotes(ctx.db, projectId)));

  ipcMain.handle("db:note:create", (_e, args) => handle(() => {
    const note = q.createNote(ctx.db, {
      ...args,
      contentText: stripMarkdown(args.content ?? ""),
    });
    if (note.type !== "dashboard") {
      suppressNextChange(note.id);
      writeNoteFile(ctx.workspacePath, {
        ...note,
        projectName: getProjectName(ctx.db, note.projectId),
      });
    }
    return note;
  }));

  ipcMain.handle("db:note:update", (_e, { id, patch }) => handle(() => {
    // archivedAt: null means "restore" — COALESCE cannot clear to NULL
    if ("archivedAt" in patch && patch.archivedAt === null) {
      const rest = { ...patch };
      delete rest.archivedAt;
      // Wrap both SQL writes in a transaction so a crash between them leaves
      // the DB in a consistent state (either both applied or neither).
      const note = ctx.db.transaction(() => {
        if (Object.keys(rest).length > 0) {
          const enrichedRest = { ...rest };
          if (rest.content !== undefined && rest.contentText === undefined) {
            enrichedRest.contentText = stripMarkdown(rest.content);
          }
          q.updateNote(ctx.db, id, enrichedRest);
        }
        return q.restoreNote(ctx.db, id);
      })();
      suppressNextChange(id);
      if (note.type !== "dashboard") {
        writeNoteFile(ctx.workspacePath, { ...note, projectName: getProjectName(ctx.db, note.projectId) });
      }
      return note;
    }
    const enrichedPatch = { ...patch };
    if (patch.content !== undefined && patch.contentText === undefined) {
      enrichedPatch.contentText = stripMarkdown(patch.content);
    }
    // Suppress before the update so the watcher's unlink event (fired when
    // writeNoteFile renames the file) is ignored before it can delete the row.
    suppressNextChange(id);
    const note = q.updateNote(ctx.db, id, enrichedPatch);
    if (note.type !== "dashboard") {
      writeNoteFile(ctx.workspacePath, {
        ...note,
        projectName: getProjectName(ctx.db, note.projectId),
      });
    }
    invalidateRelationshipCache(ctx.db, id);
    // Incremental recompute — refresh edges for this note without a full scan
    if (note.workspaceId) computeAutoRelationships(ctx.db, note.workspaceId, [id]);
    return note;
  }));

  ipcMain.handle("db:note:moveToFolder", (_e, { id, folder }: { id: string; folder: string }) => handle(() => {
    // Use moveNoteFolder (direct SET) rather than updateNote (COALESCE) so that
    // moving a note to root (folder="") is never silently ignored.
    suppressNextChange(id);
    const note = q.moveNoteFolder(ctx.db, id, folder ?? "");
    if (note.type !== "dashboard") {
      writeNoteFile(ctx.workspacePath, { ...note, projectName: getProjectName(ctx.db, note.projectId) });
    }
    return note;
  }));

  ipcMain.handle("db:note:delete", (_e, { id }) => handle(() => {
    const note = q.getNoteById(ctx.db, id);
    if (note) {
      const projectName = getProjectName(ctx.db, note.projectId);
      q.deleteNote(ctx.db, id);
      if (note.type !== "dashboard") {
        deleteNoteFile(ctx.workspacePath, projectName, id);
      }
    } else {
      q.deleteNote(ctx.db, id);
    }
  }));

  // ── Open URL in default system browser ───────────
  ipcMain.on("app:openExternal", (_e, url: string) => {
    if (typeof url === "string" && (url.startsWith("https://") || url.startsWith("http://"))) {
      shell.openExternal(url);
    }
  });

  // ── Reveal in Finder / Explorer ───────────────────
  ipcMain.handle("app:revealNote", (_e, { noteId, projectId }) => handle(() => {
    const projectName = getProjectName(ctx.db, projectId);
    const fp = findNoteFilePath(ctx.workspacePath, projectName, noteId);
    if (fp) {
      shell.showItemInFolder(fp);
    }
  }));

  // ── Asset upload (paste images into notes) ────────
  // Saves to <workspace>/attachments/ with original filename (Obsidian-compatible).
  // Returns ![[filename]] syntax so images work in both Cairn and Obsidian.
  // Legacy asset:// URLs still render via the asset:// protocol handler.
  ipcMain.handle("app:uploadAsset", (_e, { filename, data }: { filename: string; data: ArrayBuffer }) =>
    handle(() => {
      // Determine attachment folder — read from Obsidian config if available
      let attachDir: string;
      const obsidianAppJson = path.join(ctx.workspacePath, ".obsidian", "app.json");
      try {
        if (fs.existsSync(obsidianAppJson)) {
          const obsConfig = JSON.parse(fs.readFileSync(obsidianAppJson, "utf-8"));
          if (typeof obsConfig.attachmentFolderPath === "string" && obsConfig.attachmentFolderPath) {
            attachDir = path.join(ctx.workspacePath, obsConfig.attachmentFolderPath);
          } else {
            // Obsidian default: vault root
            attachDir = path.join(ctx.workspacePath, "attachments");
          }
        } else {
          attachDir = path.join(ctx.workspacePath, "attachments");
        }
      } catch {
        attachDir = path.join(ctx.workspacePath, "attachments");
      }

      fs.mkdirSync(attachDir, { recursive: true });
      const buf = Buffer.from(data);
      const ext = path.extname(filename).toLowerCase() || ".png";
      const baseName = path.basename(filename, ext);

      // Dedup: if filename already exists with different content, append suffix
      let destName = `${baseName}${ext}`;
      let destPath = path.join(attachDir, destName);
      let counter = 1;
      while (fs.existsSync(destPath)) {
        // Same content → reuse existing file
        if (fs.statSync(destPath).size === buf.length) {
          const existing = fs.readFileSync(destPath);
          if (buf.equals(existing)) break;
        }
        destName = `${baseName}-${counter}${ext}`;
        destPath = path.join(attachDir, destName);
        counter++;
      }

      if (!fs.existsSync(destPath)) {
        fs.writeFileSync(destPath, buf);
      }

      // Return Obsidian-compatible embed syntax
      return { assetUrl: `![[${destName}]]` };
    })
  );

  // ── Reveal assets folder in Finder / Explorer ─────
  ipcMain.handle("app:revealAssets", () => handle(async () => {
    const assetDir = path.join(ctx.workspacePath, "assets");
    fs.mkdirSync(assetDir, { recursive: true });
    // shell.openPath returns a Promise<string>; non-empty = error message.
    const errMsg = await shell.openPath(assetDir);
    if (errMsg) console.error("[cairn:revealAssets]", errMsg);
  }));

  // ── Board columns ─────────────────────────────────
  ipcMain.handle("db:column:list", (_e, { projectId }) => handle(() => q.getColumns(ctx.db, projectId)));
  ipcMain.handle("db:column:create", (_e, args) => handle(() => q.createColumn(ctx.db, args)));
  ipcMain.handle("db:column:update", (_e, { id, patch }) => handle(() => q.updateColumn(ctx.db, id, patch)));
  ipcMain.handle("db:column:delete", (_e, { id }) => handle(() => q.deleteColumn(ctx.db, id)));

  // ── Task cards ────────────────────────────────────
  ipcMain.handle("db:card:list", (_e, opts) => handle(() => q.getCards(ctx.db, opts)));
  ipcMain.handle("db:card:create", (_e, args) => handle(() => {
    const title = (args?.title as string | null | undefined)?.trim();
    if (!title) throw new Error("Task title is required");
    return q.createCard(ctx.db, { ...args, title });
  }));
  ipcMain.handle("db:card:update", (_e, { id, patch }) => handle(() => {
    // archivedAt: null means "restore" — COALESCE cannot clear to NULL
    if ("archivedAt" in patch && patch.archivedAt === null) {
      const rest = { ...patch };
      delete rest.archivedAt;
      if (Object.keys(rest).length > 0) q.updateCard(ctx.db, id, rest);
      return q.restoreCard(ctx.db, id);
    }
    // dueDate: null means "clear due date"
    if ("dueDate" in patch && patch.dueDate === null) {
      const rest = { ...patch };
      delete rest.dueDate;
      if (Object.keys(rest).length > 0) q.updateCard(ctx.db, id, rest);
      return q.clearCardDueDate(ctx.db, id);
    }
    const card = q.updateCard(ctx.db, id, patch);
    invalidateRelationshipCache(ctx.db, id);
    // Incremental recompute — refresh edges for this card without a full scan
    if (card.workspaceId) computeAutoRelationships(ctx.db, card.workspaceId, [id]);
    // When a card moves to a Done column, remove it from every other card's blockedByIds
    if (patch.columnId) {
      const col = ctx.db
        .prepare("SELECT type FROM board_columns WHERE id = ?")
        .get(patch.columnId) as { type: string } | undefined;
      if (col?.type === "done") q.clearBlockersFromAll(ctx.db, [id]);
    }
    return card;
  }));
  ipcMain.handle("db:card:delete", (_e, { id }) => handle(() => q.deleteCard(ctx.db, id)));

  // Archive every non-archived card in a given Done-type column
  ipcMain.handle("db:cards:archive-done", (_e, { columnId }: { columnId: string }) => handle(() => {
    const col = ctx.db.prepare("SELECT * FROM board_columns WHERE id = ?").get(columnId) as { type: string } | undefined;
    if (!col) throw new Error("Column not found");
    if (col.type !== "done") throw new Error("Only Done-type columns can be bulk-archived");
    const now = new Date().toISOString();
    const result = ctx.db.prepare(
      "UPDATE task_cards SET archived_at = ?, updated_at = ?, version = version + 1 WHERE column_id = ? AND archived_at IS NULL"
    ).run(now, now, columnId);
    return { archived: result.changes };
  }));

  // ── Card dependencies ─────────────────────────────
  ipcMain.handle("db:card:addBlocker", (_e, { cardId, blockerCardId }) => handle(() => {
    const card = q.getCardById(ctx.db, cardId);
    const blocker = q.getCardById(ctx.db, blockerCardId);
    if (!card) return { error: "Card not found" };
    if (!blocker) return { error: "Blocker card not found" };
    if (card.projectId !== blocker.projectId) return { error: "Cards must be in the same project" };
    if (cardId === blockerCardId) return { error: "A card cannot block itself" };
    // Circular dependency check: would blockerCardId become reachable from cardId?
    // i.e. if cardId already blocks blockerCardId (directly or transitively), reject.
    const projectCards = q.getCards(ctx.db, { projectId: card.projectId });
    const cardLookup = new Map(projectCards.map((c) => [c.id, c]));
    function canReach(from: string, target: string, visited = new Set<string>()): boolean {
      if (from === target) return true;
      if (visited.has(from)) return false;
      visited.add(from);
      const node = cardLookup.get(from);
      if (!node) return false;
      return node.blockedByIds.some((bid) => canReach(bid, target, visited));
    }
    if (canReach(blockerCardId, cardId, new Set())) {
      return { error: "Circular dependency detected" };
    }
    return q.addCardBlocker(ctx.db, cardId, blockerCardId);
  }));

  ipcMain.handle("db:card:removeBlocker", (_e, { cardId, blockerCardId }) => handle(() =>
    q.removeCardBlocker(ctx.db, cardId, blockerCardId)
  ));

  ipcMain.handle("db:card:ready", (_e, { projectId }) => handle(() =>
    q.getReadyCards(ctx.db, projectId)
  ));

  // ── Idea Flow ─────────────────────────────────────
  ipcMain.handle("db:flow:get", (_e, { projectId }) => handle(() => q.getResolvedFlow(ctx.db, projectId)));
  ipcMain.handle("db:flow:node:create", (_e, args) => handle(() => {
    const flow = q.getOrCreateFlow(ctx.db, args.projectId);
    return q.createFlowNode(ctx.db, { ...args, flowId: flow.id, id: q.generateId() });
  }));
  ipcMain.handle("db:flow:node:update", (_e, { id, patch }) => handle(() => q.updateFlowNode(ctx.db, id, patch)));
  ipcMain.handle("db:flow:node:delete", (_e, { id }) => handle(() => q.deleteFlowNode(ctx.db, id)));
  ipcMain.handle("db:flow:edge:create", (_e, args) => handle(() => {
    const flow = q.getOrCreateFlow(ctx.db, args.projectId);
    return q.createFlowEdge(ctx.db, { ...args, flowId: flow.id, id: q.generateId() });
  }));
  ipcMain.handle("db:flow:edge:delete", (_e, { id }) => handle(() => q.deleteFlowEdge(ctx.db, id)));

  // Generate an AI summary for an ai_summary node.
  // Recursively walks the entire connected subgraph (BFS in both edge directions),
  // collecting all ancestor/peer content nodes transitively — not just direct neighbours.
  // Other ai_summary nodes in the graph are skipped to avoid circular self-reference.
  ipcMain.handle("db:flow:node:summarize", async (_e, args: {
    nodeId: string;
    config: { baseUrl: string; model: string; apiKey: string };
  }) => {
    const baseUrl = normaliseBaseUrl(args.config.baseUrl || "https://api.openai.com");
    const model = args.config.model || "gpt-4o-mini";
    const apiKey = args.config.apiKey || "";
    const isLocal = isLocalEndpoint(baseUrl);
    if (!apiKey && !isLocal) {
      return err("AI is not configured. Add an API key in Settings → AI & Chat, or use a local endpoint.");
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const nodeRow = ctx.db.prepare("SELECT * FROM idea_flow_nodes WHERE id = ?").get(args.nodeId) as any | undefined;
    if (!nodeRow) return err("Node not found");

    const flowId = nodeRow.flow_id as string;

    // Load all edges for this flow once
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const allEdges = ctx.db.prepare("SELECT * FROM idea_flow_edges WHERE flow_id = ?").all(flowId) as any[];

    // BFS: traverse all nodes reachable from the summary node (both edge directions),
    // excluding the summary node itself and other ai_summary nodes.
    const visited = new Set<string>([args.nodeId]);
    const queue: string[] = [];

    // Seed queue with direct neighbours
    for (const e of allEdges) {
      if (e.source_node_id === args.nodeId && !visited.has(e.target_node_id)) {
        queue.push(e.target_node_id);
        visited.add(e.target_node_id);
      }
      if (e.target_node_id === args.nodeId && !visited.has(e.source_node_id)) {
        queue.push(e.source_node_id);
        visited.add(e.source_node_id);
      }
    }

    // BFS expansion
    while (queue.length > 0) {
      const current = queue.shift()!;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const currentRow = ctx.db.prepare("SELECT type FROM idea_flow_nodes WHERE id = ?").get(current) as any;
      // Don't recurse through other ai_summary nodes — they're peers, not content
      if (currentRow?.type === "ai_summary") continue;

      for (const e of allEdges) {
        if (e.source_node_id === current && !visited.has(e.target_node_id)) {
          queue.push(e.target_node_id);
          visited.add(e.target_node_id);
        }
        if (e.target_node_id === current && !visited.has(e.source_node_id)) {
          queue.push(e.source_node_id);
          visited.add(e.source_node_id);
        }
      }
    }

    // Remove the summary node itself from the set
    visited.delete(args.nodeId);

    if (visited.size === 0) {
      return err("Connect this node to other nodes first — nothing to summarise yet.");
    }

    // Build a text description of each collected node
    const parts: string[] = [];
    for (const nid of visited) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const nrow = ctx.db.prepare("SELECT * FROM idea_flow_nodes WHERE id = ?").get(nid) as any;
      if (!nrow) continue;
      let data: Record<string, unknown> = {};
      try { data = JSON.parse(nrow.data); } catch { /* empty */ }

      const type = nrow.type as string;
      if (type === "idea") {
        const title = data.title as string | undefined;
        const body = data.body as string | undefined;
        parts.push(`[Idea] ${title ?? "Untitled"}${body ? `: ${body}` : ""}`);
      } else if (type === "note_ref" && data.noteId) {
        const noteRow = ctx.db.prepare("SELECT title, content_text FROM notes WHERE id = ?").get(data.noteId) as
          { title: string; content_text: string } | undefined;
        if (noteRow) parts.push(`[Note] ${noteRow.title}: ${noteRow.content_text?.slice(0, 600) ?? ""}`);
      } else if (type === "task_ref" && data.cardId) {
        const cardRow = ctx.db.prepare(
          "SELECT tc.title, tc.description, tc.priority, bc.name as col FROM task_cards tc LEFT JOIN board_columns bc ON tc.column_id = bc.id WHERE tc.id = ?"
        ).get(data.cardId) as { title: string; description: string; priority: string; col: string } | undefined;
        if (cardRow) parts.push(`[Task] ${cardRow.title} (${cardRow.priority}, ${cardRow.col})${cardRow.description ? `: ${cardRow.description}` : ""}`);
      } else if (type === "url") {
        const title = data.title as string | undefined;
        const url = data.url as string | undefined;
        const desc = data.description as string | undefined;
        parts.push(`[URL] ${title ?? url ?? "Link"}${desc ? `: ${desc}` : ""}`);
      }
      // ai_summary nodes are excluded from content collection (skipped in BFS above)
    }

    if (parts.length === 0) {
      return err("No content found in the connected nodes — add text to the idea, note, or task nodes first.");
    }

    const userPrompt = `Summarise the following connected items into a concise paragraph (3–5 sentences). Focus on themes, relationships, and key points. Reply with plain prose only — no bullet points, no headers, no XML, no tool calls, no markdown formatting of any kind.\n\n${parts.join("\n\n")}`;
    const systemPrompt = "You are a concise synthesis assistant. Your only job is to write a short prose paragraph summarising the provided content. Output plain text only — no XML, no tool calls, no function invocations, no markdown, no bullet points, no headings. Just the summary text.";

    let summary: string;
    try {
      summary = await callLLM({ baseUrl, model, apiKey }, systemPrompt, userPrompt);
    } catch (e) {
      return err(`AI call failed: ${(e as Error).message}`);
    }

    // Write summary back into the node's data
    q.updateFlowNode(ctx.db, args.nodeId, { data: { content: summary.trim() } });
    return ok({ nodeId: args.nodeId, content: summary.trim() });
  });

  // ── Tags ──────────────────────────────────────────
  ipcMain.handle("db:tag:list", (_e, { workspaceId }) => handle(() => q.getTags(ctx.db, workspaceId)));
  ipcMain.handle("db:tag:create", (_e, args) => handle(() => q.createTag(ctx.db, args)));
  ipcMain.handle("db:tag:update", (_e, { id, patch }) => handle(() => q.updateTag(ctx.db, id, patch)));
  ipcMain.handle("db:tag:delete", (_e, { id }) => handle(() => q.deleteTag(ctx.db, id)));

  // ── Chat ──────────────────────────────────────────
  ipcMain.handle("db:chat:threads", (_e, { workspaceId }) => handle(() => q.getChatThreads(ctx.db, workspaceId)));
  ipcMain.handle("db:chat:messages", (_e, { threadId }) => handle(() => q.getChatMessages(ctx.db, threadId)));
  ipcMain.handle("db:chat:upsertThread", (_e, args) => handle(() => q.upsertChatThread(ctx.db, args)));
  ipcMain.handle("db:chat:addMessage", (_e, args) => handle(() => q.addChatMessage(ctx.db, args)));
  ipcMain.handle("db:chat:deleteThread", (_e, { threadId }) => handle(() => q.deleteChatThread(ctx.db, threadId)));

  // ── Pi Agent Sessions ─────────────────────────────────────────────────────────────────────────────────
  ipcMain.handle("db:piSession:list", (_e, { projectId }) => handle(() => q.getPiSessions(ctx.db, projectId)));
  ipcMain.handle("db:piSession:create", (_e, args) => handle(() => q.createPiSession(ctx.db, args)));
  ipcMain.handle("db:piSession:delete", (_e, { id }) => handle(() => q.deletePiSession(ctx.db, id)));
  ipcMain.handle("db:piSession:messages", (_e, { sessionId }) => handle(() => q.getPiMessages(ctx.db, sessionId)));
  ipcMain.handle("db:piSession:saveMessages", (_e, { sessionId, messages }) => handle(() => q.savePiMessages(ctx.db, sessionId, messages)));

  // ── AI Chat completions ───────────────────────────────────────────────────────────────────
  registerChatHandler(ctx.db, ctx.workspacePath, ctx.getWin);

  ipcMain.handle("ai:localLLMStatus", async () => {
    return handle(async () => {
      const { isLocalLLMAvailable } = await import("../lib/local-llm");
      return await isLocalLLMAvailable();
    });
  });

  /* eslint-disable @typescript-eslint/no-require-imports */
  // ── Local Llama & Gemma 4 Server ──────────────────────────────────────────
  ipcMain.handle("llama:models:list", () => handle(() => {
    const { listModels } = require("../lib/llama-server");
    return listModels();
  }));

  ipcMain.handle("llama:models:install", (_e, { modelId, useMirror }) => handle(async () => {
    const { installModel } = require("../lib/llama-server");
    return await installModel(modelId, ctx.getWin, useMirror);
  }));

  ipcMain.handle("llama:binary:install", () => handle(async () => {
    const { installLlamaBinary } = require("../lib/llama-server");
    return await installLlamaBinary(ctx.getWin);
  }));

  ipcMain.handle("llama:binary:check-update", () => handle(async () => {
    const { checkLlamaUpdates } = require("../lib/llama-server");
    return await checkLlamaUpdates();
  }));

  ipcMain.handle("llama:models:remove", (_e, { modelId }) => handle(() => {
    const { removeModel } = require("../lib/llama-server");
    return removeModel(modelId);
  }));

  ipcMain.handle("llama:models:clearInactive", () => handle(() => {
    const { clearInactiveModels } = require("../lib/llama-server");
    return clearInactiveModels();
  }));

  ipcMain.handle("llama:server:start", (_e, { modelId }) => handle(async () => {
    const { startServer } = require("../lib/llama-server");
    const port = await startServer(modelId);
    return { port };
  }));

  ipcMain.handle("llama:server:setDefault", (_e, { modelId }) => handle(() => {
    const { setDefaultModelId } = require("../lib/llama-server");
    setDefaultModelId(modelId);
    return { success: true };
  }));

  ipcMain.handle("llama:server:stop", () => handle(async () => {
    const { stopServer } = require("../lib/llama-server");
    return await stopServer();
  }));

  ipcMain.handle("llama:server:status", () => handle(async () => {
    const { getServerStatus } = require("../lib/llama-server");
    return await getServerStatus();
  }));
  /* eslint-enable @typescript-eslint/no-require-imports */

  // ── AI PRD generation (direct, no chat loop) ──────
  ipcMain.handle("ai:generatePrd", async (_e, args: {
    projectId: string;
    title: string;
    requirements: string;
    config: { baseUrl: string; model: string; apiKey: string };
  }) => {
    // PRD returns its own { error } shape for user-facing validation errors
    const baseUrl = normaliseBaseUrl(args.config.baseUrl || "https://api.openai.com");
    const model = args.config.model || "gpt-4o-mini";
    const apiKey = args.config.apiKey || "";
    const isLocal = isLocalEndpoint(baseUrl);
    if (!apiKey && !isLocal) {
      return err("AI is not configured. Add an API key in Settings → AI & Chat, or use a local endpoint.");
    }
    const llmConfig = { baseUrl, model, apiKey };
    return handle(() => generatePrd(ctx.db, ctx.workspacePath, {
      projectId: args.projectId,
      title: args.title,
      requirements: args.requirements,
    }, llmConfig));
  });

  // ── Knowledge Graph ────────────────────────────────
  ipcMain.handle("db:graph:get", (_e, args: {
    workspaceId: string;
    filters?: GraphFilters;
  }) => handle(() => getKnowledgeGraph(ctx.db, args.workspaceId, args.filters ?? {})));

  ipcMain.handle("db:graph:neighbors", (_e, args: {
    workspaceId: string;
    nodeId: string;
    depth?: number;
    edgeTypes?: EdgeType[];
  }) => handle(() => getNeighbours(ctx.db, args.workspaceId, args.nodeId, args.depth ?? 1, args.edgeTypes)));

  ipcMain.handle("db:graph:recompute", (_e, args: {
    workspaceId: string;
    entityIds?: string[];
  }) => handle(() => {
    computeAutoRelationships(ctx.db, args.workspaceId, args.entityIds);
    return { ok: true };
  }));
}

/**
 * Register app-level IPC handlers that were previously inlined in main.ts.
  *
  * @param db              - the SQLite database instance
  * @param userDataPath    - result of app.getPath("userData")
  * @param updateTrayBadge - callback to update the tray badge count
  */
export function registerAppHandlers(
  ctx: DbContext,
  userDataPath: string,
  updateTrayBadge: (count: number) => void,
  onReinitialise?: (newWorkspacePath: string) => Promise<void>,
  /** Called when the badge is cleared from the renderer — resets poller count too. */
  onBadgeClear?: () => void,
): void {
  // ── Workspace folder selection / setup ────────────
  ipcMain.handle("app:selectWorkspaceFolder", async () => {
    return handle(async () => {
      const result = await dialog.showOpenDialog({
        // title renders on all platforms; message is macOS-only and silently ignored on Windows
        title: "Select a folder where Cairn will store your notes and database.",
        buttonLabel: "Use This Folder",
        properties: ["openDirectory", "createDirectory"],
      });
      if (result.canceled || result.filePaths.length === 0) return null;
      const chosen = result.filePaths[0];
      writeWorkspaceConfig(userDataPath, chosen);
      return chosen;
    });
  });

  ipcMain.handle("app:getWorkspacePath", () => handle(() =>
    readWorkspaceConfig(userDataPath)?.workspacePath ?? null
  ));

  ipcMain.handle("app:needsWorkspaceSetup", () => handle(() =>
    readWorkspaceConfig(userDataPath) === null
  ));

  ipcMain.handle("app:setTheme", (_e, theme: string) => handle(() => {
    const themeFile = path.join(userDataPath, "theme.json");
    fs.writeFileSync(themeFile, JSON.stringify({ theme }), "utf8");
    // On Windows, update the native title bar overlay to match the new theme.
    // Use --surface values (not backgroundColor) to match TitleBar's bg-[var(--surface)].
    // height:39 not 40 — Windows 1px window border makes 40 clip the border-b below the bar.
    if (process.platform === "win32") {
      const activeWin = ctx.getWin();
      if (activeWin && !activeWin.isDestroyed()) {
        const surface = theme === "light" ? "#ffffff" : "#141414";
        activeWin.setTitleBarOverlay({ color: surface, symbolColor: "#888888", height: 39 });
      }
    }
  }));

  ipcMain.handle("app:initWorkspace", (_e, { workspacePath: newPath }: { workspacePath: string }) => handle(async () => {
    writeWorkspaceConfig(userDataPath, newPath);
    fs.mkdirSync(newPath, { recursive: true });
    if (onReinitialise) {
      await onReinitialise(newPath);
    }
    return { ok: true };
  }));

  // ── App paths (for MCP config generation) ─────────
  ipcMain.handle("app:mcpServerPath", () => handle(() => {
    const appPath = app.getAppPath();
    const unpackedPath = appPath.replace(/\.asar$/, ".asar.unpacked");
    const binaryName = process.platform === "win32" ? "cairn-mcp.exe"
      : process.platform === "linux" ? "cairn-mcp-linux"
        : "cairn-mcp";
    return path.join(unpackedPath, "dist-mcp", binaryName);
  }));

  // ── Latest changelog ───────────────────────────────
  ipcMain.handle("app:latestChangelog", () => handle(() => {
    // In dev, app.getAppPath() points to dist-electron/ — walk up to repo root instead.
    // In packaged builds, changelogs/ is bundled inside the asar alongside dist-electron/.
    const changelogsDir = app.isPackaged
      ? path.join(app.getAppPath(), "changelogs")
      : path.join(__dirname, "..", "changelogs");
    if (!fs.existsSync(changelogsDir)) return null;
    const files = fs.readdirSync(changelogsDir)
      .filter((f) => /^v\d+\.\d+\.\d+\.md$/.test(f));
    if (files.length === 0) return null;
    // Sort by semver descending and pick the highest
    files.sort((a, b) => {
      const parse = (f: string) => f.replace(/^v/, "").replace(/\.md$/, "").split(".").map(Number);
      const [aMaj, aMin, aPatch] = parse(a);
      const [bMaj, bMin, bPatch] = parse(b);
      return bMaj - aMaj || bMin - aMin || bPatch - aPatch;
    });
    return fs.readFileSync(path.join(changelogsDir, files[0]), "utf8");
  }));

  // ── Reset all data — wipe every table then relaunch ──────────────────────
  ipcMain.handle("app:reset", () => handle(() => {
    const tables = ["chat_messages", "chat_threads", "mcp_notifications", "task_cards", "board_columns", "notes", "tags", "projects", "workspaces"];
    for (const t of tables) {
      ctx.db.prepare(`DELETE FROM ${t}`).run();
    }
    app.relaunch();
    app.quit();
  }));

  // ── Relaunch (used after workspace init to re-open DB at correct path) ──
  ipcMain.handle("app:relaunch", () => handle(() => {
    app.relaunch();
    app.quit();
  }));

  // ── Auto-updater install ───────────────────────────
  ipcMain.handle("updater:install", () => handle(() => {
    // Dynamically require to avoid issues in dev where autoUpdater isn't active.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { autoUpdater } = require("electron-updater");
    autoUpdater.quitAndInstall();
  }));

  // ── MCP notification handler ───────────────────────
  ipcMain.handle("mcp:markNotificationsRead", () => handle(() => {
    markMcpNotificationsRead(ctx.db);
    updateTrayBadge(0);
    onBadgeClear?.();
  }));

  // ── Export note as PDF ─────────────────────────────
  ipcMain.handle("app:exportNotePdf", (_e, { title, html }: { title: string; html: string }) =>
    handle(async () => {
      const activeWin = ctx.getWin();
      if (!activeWin || activeWin.isDestroyed()) throw new Error("No window");

      const { canceled, filePath: savePath } = await dialog.showSaveDialog(activeWin, {
        title: "Export Note as PDF",
        defaultPath: `${title}.pdf`,
        filters: [{ name: "PDF Document", extensions: ["pdf"] }],
      });
      if (canceled || !savePath) return null;

      // Wrap the rendered HTML in a self-contained document with light-theme
      // prose-cairn styles inlined so the PDF is readable regardless of app theme.
      const fullHtml = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>${title.replace(/</g, "&lt;")}</title>
<style>
*, *::before, *::after { box-sizing: border-box; }
:root {
  --text-primary: #1a1917;
  --text-secondary: #4a4744;
  --surface-2: #f0eeeb;
  --border: #dddad6;
  --accent: #6457e8;
}
@page {
  size: A4;
  margin: 2cm 2.2cm;
}
body {
  margin: 0;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  background: #ffffff;
  color: #1a1917;
  /* Ensure nothing overflows the page width */
  max-width: 100%;
  overflow-x: hidden;
  word-wrap: break-word;
  overflow-wrap: break-word;
}
.prose-cairn { color: var(--text-primary); font-size: 0.875rem; line-height: 1.7; }
.prose-cairn h1 { font-size: 1.5rem; font-weight: 700; margin: 1.25rem 0 0.5rem; color: var(--text-primary); }
.prose-cairn h2 { font-size: 1.2rem; font-weight: 600; margin: 1rem 0 0.4rem; color: var(--text-primary); }
.prose-cairn h3 { font-size: 1rem; font-weight: 600; margin: 0.75rem 0 0.3rem; color: var(--text-primary); }
.prose-cairn p { margin: 0.5rem 0; word-wrap: break-word; overflow-wrap: break-word; }
.prose-cairn strong { font-weight: 600; }
.prose-cairn em { font-style: italic; }
.prose-cairn code { font-family: ui-monospace, monospace; font-size: 0.8em; background: var(--surface-2); border: 1px solid var(--border); border-radius: 3px; padding: 0.1em 0.35em; word-break: break-all; }
/* Code blocks: overflow wraps rather than clips */
.prose-cairn pre { margin: 0.75rem 0; padding: 0.75rem 1rem; background: var(--surface-2) !important; color: #374151 !important; border: 1px solid var(--border); border-radius: 6px; overflow-x: auto; white-space: pre-wrap; word-wrap: break-word; word-break: break-all; max-width: 100%; }
.prose-cairn pre code { background: none !important; border: none; padding: 0; font-size: 0.8rem; white-space: pre-wrap; word-break: break-all; }
.prose-cairn ul { list-style: disc; padding-left: 1.5rem; margin: 0.5rem 0; }
.prose-cairn ol { list-style: decimal; padding-left: 1.5rem; margin: 0.5rem 0; }
.prose-cairn li { margin: 0.2rem 0; }
.prose-cairn blockquote { border-left: 3px solid var(--accent); margin: 0.75rem 0; padding: 0.25rem 0 0.25rem 1rem; color: var(--text-secondary); }
.prose-cairn hr { border: none; border-top: 1px solid var(--border); margin: 1rem 0; }
.prose-cairn a { color: var(--accent); text-decoration: underline; word-break: break-all; }
.prose-cairn table { width: 100%; border-collapse: collapse; font-size: 0.8rem; margin: 0.75rem 0; table-layout: fixed; word-wrap: break-word; }
.prose-cairn th { background: var(--surface-2); font-weight: 600; text-align: left; padding: 0.4rem 0.6rem; border: 1px solid var(--border); word-wrap: break-word; }
.prose-cairn td { padding: 0.35rem 0.6rem; border: 1px solid var(--border); word-wrap: break-word; }
.prose-cairn tr:nth-child(even) td { background: var(--surface-2); }
/* Wikilink chips */
.wikilink-chip { display: inline-flex; align-items: center; gap: 3px; color: var(--accent); font-size: 0.85em; }
/* Callout blocks */
.callout { border-left: 3px solid var(--accent); background: var(--surface-2); padding: 0.5rem 0.75rem; margin: 0.75rem 0; border-radius: 0 4px 4px 0; }
/* Page break hints */
h1, h2, h3 { page-break-after: avoid; }
pre, blockquote, table { page-break-inside: avoid; }
</style>
</head>
<body>
<div class="prose-cairn">${html}</div>
</body>
</html>`;

      // Open a hidden window, load the HTML, print to PDF, then close
      const printWin = new BrowserWindow({
        show: false,
        webPreferences: { nodeIntegration: false, contextIsolation: true },
      });

      await printWin.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(fullHtml)}`);

      const pdfBuffer = await printWin.webContents.printToPDF({
        printBackground: true,
        pageSize: "A4",
        // Margins are defined via @page in the HTML — use "default" so the
        // CSS @page rule is respected rather than being overridden here.
        margins: { marginType: "default" },
      });

      printWin.destroy();

      fs.writeFileSync(savePath, pdfBuffer);
      return { filePath: savePath };
    })
  );

  // ── URL metadata fetch (OG tags + <title>) ─────────
  // Runs in the main process so there are no CORS restrictions.
  ipcMain.handle("db:flow:url:fetch", (_e, { url }: { url: string }) =>
    handle(async () => {
      // Basic URL validation
      let parsed: URL;
      try { parsed = new URL(url); } catch { throw new Error("Invalid URL"); }
      if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("Only http/https URLs are supported");

      const response = await net.fetch(url, {
        method: "GET",
        headers: { "User-Agent": "Mozilla/5.0 (compatible; Cairn/1.0)" },
        // Limit response size — we only need the <head>
        signal: AbortSignal.timeout(8000),
      });

      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      // Only read up to ~50 KB — enough to capture the <head>
      const reader = response.body?.getReader();
      let html = "";
      let bytesRead = 0;
      const limit = 50_000;
      if (reader) {
        while (bytesRead < limit) {
          const { done, value } = await reader.read();
          if (done) break;
          html += new TextDecoder().decode(value);
          bytesRead += value.byteLength;
          // Stop once we have the closing </head> or enough bytes
          if (html.includes("</head>") || html.includes("</title>")) break;
        }
        reader.cancel();
      }

      // Extract OG title → plain title → hostname fallback
      const ogTitle = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)?.[1]
        ?? html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i)?.[1];
      const ogDesc = html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i)?.[1]
        ?? html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:description["']/i)?.[1]
        ?? html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i)?.[1]
        ?? html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["']/i)?.[1];
      const htmlTitle = html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1];

      const title = (ogTitle ?? htmlTitle ?? "").trim().slice(0, 200);
      const description = (ogDesc ?? "").trim().slice(0, 500);

      return { title, description };
    })
  );

  // ── Migration handlers ─────────────────────────────
  ipcMain.handle("app:checkMigrations", () => handle(() =>
    checkMigrations(ctx.workspacePath)
  ));

  ipcMain.handle("app:runMigration", (_e, { migrationId }: { migrationId: string }) =>
    handle(async () => {
      await runMigration(ctx.workspacePath, migrationId, (pct, msg) => {
        // Send progress events to the renderer
        const activeWin = ctx.getWin();
        if (activeWin && !activeWin.isDestroyed()) {
          activeWin.webContents.send("app:migrationProgress", { migrationId, pct, msg });
        }
      });
      return { ok: true };
    })
  );
}
