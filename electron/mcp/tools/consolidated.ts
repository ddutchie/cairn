/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Consolidated Cairn toolset — the tools the model sees (TOOL_SCHEMAS) mapped
 * onto the per-operation handlers in this folder.
 *
 * The model-facing surface is one tool per intent (search_tasks with a filter
 * instead of list_overdue_tasks / list_tasks_due / list_ready_tasks, one
 * update_tasks instead of update_task + bulk_update_task_status + tag_task +
 * link/unlink, …). Each consolidated call is translated here into one or more
 * calls to the existing handlers, which stay the single implementation of the
 * actual reads and writes (validation, notifications, .md files, relationship
 * refresh). Those handler names are internal: they are never advertised.
 *
 * Shared by both executors: the MCP server passes its legacy dispatcher as
 * `call`, the in-app chat passes its own (which adds AI write locks and the
 * chat-only get_active_context). Pure SQL lookups only — no Database is
 * constructed here.
 */
import type Database from "better-sqlite3";

type Args = Record<string, any>;
/** Run one internal (per-operation) handler by name. */
export type HandlerCall = (name: string, args: Args) => unknown | Promise<unknown>;

export interface ConsolidatedOptions {
  /** "chat" resolves get_context to the active workspace/project; "mcp" to the workspace overview. */
  surface: "chat" | "mcp";
  /** Chat's active workspace, used when a call doesn't pin one. */
  activeWorkspaceId?: string;
}

/** Model-facing tool names that this module implements. */
export const CONSOLIDATED_TOOLS: ReadonlySet<string> = new Set([
  "get_context", "get_item", "search_notes", "search_tasks",
  "ensure_note", "edit_note", "update_notes",
  "create_task", "update_tasks", "task_progress",
  "delete", "edit_idea_flow", "get_graph", "codebase_query",
]);

const isErr = (r: unknown): r is { error: string } =>
  !!r && typeof r === "object" && !Array.isArray(r) && typeof (r as { error?: unknown }).error === "string";

const list = (x: unknown): string[] => (Array.isArray(x) ? x.filter((v): v is string => typeof v === "string" && v.length > 0) : []);

/** Fold per-step results into one response; errors are surfaced, never swallowed. */
function summarize(base: Args, errors: string[]): Args {
  return errors.length > 0 ? { ...base, error: errors.join("; ") } : base;
}

// ── SQL lookups ────────────────────────────────────────────────────────────

function noteRow(db: Database.Database, id: string) {
  return db.prepare("SELECT id, project_id AS projectId, workspace_id AS workspaceId, title FROM notes WHERE id = ? AND deleted_at IS NULL")
    .get(id) as { id: string; projectId: string; workspaceId: string; title: string } | undefined;
}

function cardRow(db: Database.Database, id: string) {
  return db.prepare("SELECT id, project_id AS projectId, workspace_id AS workspaceId, title, column_id AS columnId FROM task_cards WHERE id = ? AND deleted_at IS NULL")
    .get(id) as { id: string; projectId: string; workspaceId: string; title: string; columnId: string } | undefined;
}

/** First column of `type` in the project (board order), or undefined. */
function columnOfType(db: Database.Database, projectId: string, type: string): string | undefined {
  const row = db.prepare('SELECT id FROM board_columns WHERE project_id = ? AND type = ? ORDER BY "order" LIMIT 1')
    .get(projectId, type) as { id: string } | undefined;
  return row?.id;
}

function firstColumn(db: Database.Database, projectId: string): string | undefined {
  const row = db.prepare('SELECT id FROM board_columns WHERE project_id = ? ORDER BY "order" LIMIT 1')
    .get(projectId) as { id: string } | undefined;
  return row?.id;
}

/** Workspace for a call: from the project or node it names, else the active one, else the first. */
function resolveWorkspaceId(db: Database.Database, opts: ConsolidatedOptions, hint: { projectId?: string; nodeId?: string }): string | undefined {
  const byId = (sql: string, id: string) => (db.prepare(sql).get(id) as { ws?: string } | undefined)?.ws;
  if (hint.projectId) {
    const ws = byId("SELECT workspace_id AS ws FROM projects WHERE id = ?", hint.projectId);
    if (ws) return ws;
  }
  if (hint.nodeId) {
    for (const sql of [
      "SELECT workspace_id AS ws FROM notes WHERE id = ?",
      "SELECT workspace_id AS ws FROM task_cards WHERE id = ?",
      "SELECT workspace_id AS ws FROM projects WHERE id = ?",
      "SELECT workspace_id AS ws FROM tags WHERE id = ?",
    ]) {
      const ws = byId(sql, hint.nodeId);
      if (ws) return ws;
    }
  }
  if (opts.activeWorkspaceId) return opts.activeWorkspaceId;
  return (db.prepare("SELECT id FROM workspaces WHERE deleted_at IS NULL AND archived_at IS NULL ORDER BY created_at LIMIT 1").get() as { id: string } | undefined)?.id;
}

/** Card ids (in `ids`) that carry the given tag name / assignee. */
function cardsMatching(db: Database.Database, ids: string[], f: { tag?: string; assignee?: string }): Set<string> {
  if (ids.length === 0) return new Set();
  const rows = db.prepare(`SELECT id, tag_ids AS tagIds, assignee FROM task_cards WHERE id IN (${ids.map(() => "?").join(",")})`)
    .all(...ids) as { id: string; tagIds: string | null; assignee: string | null }[];
  const tagId = f.tag ? tagIdByName(db, f.tag) : undefined;
  return new Set(rows.filter((r) => {
    if (f.assignee && (r.assignee ?? "").toLowerCase() !== f.assignee.toLowerCase()) return false;
    if (f.tag && (!tagId || !(JSON.parse(r.tagIds ?? "[]") as string[]).includes(tagId))) return false;
    return true;
  }).map((r) => r.id));
}

function tagIdByName(db: Database.Database, name: string): string | undefined {
  return (db.prepare("SELECT id FROM tags WHERE lower(name) = lower(?) LIMIT 1").get(name) as { id: string } | undefined)?.id;
}

/** Note ids (in `ids`) that match the project / folder / type filters. */
function notesMatching(db: Database.Database, ids: string[], f: { projectId?: string; folder?: string; type?: string }): Set<string> {
  if (ids.length === 0) return new Set();
  const rows = db.prepare(`SELECT id, project_id AS projectId, folder, type FROM notes WHERE id IN (${ids.map(() => "?").join(",")})`)
    .all(...ids) as { id: string; projectId: string; folder: string | null; type: string | null }[];
  return new Set(rows.filter((r) =>
    (!f.projectId || r.projectId === f.projectId) &&
    (f.folder === undefined || (r.folder ?? "").toLowerCase() === f.folder.toLowerCase()) &&
    (!f.type || (r.type ?? "note") === f.type),
  ).map((r) => r.id));
}

// ── Dispatcher ─────────────────────────────────────────────────────────────

export async function runConsolidatedTool(
  db: Database.Database,
  name: string,
  args: Args,
  call: HandlerCall,
  opts: ConsolidatedOptions,
): Promise<unknown> {
  switch (name) {
    case "get_context": {
      if (!args.projectId) return call(opts.surface === "chat" ? "get_active_context" : "get_cairn_context", {});
      const pack = await call("get_project_context_pack", { projectId: args.projectId });
      if (isErr(pack)) return pack;
      const folders = await call("list_folders", { projectId: args.projectId }) as { folders?: string[] };
      const templates = await call("list_templates", { projectId: args.projectId });
      return { ...(pack as Args), folders: folders?.folders ?? [], templates: Array.isArray(templates) ? templates : [] };
    }

    case "get_item": {
      const id = String(args.id ?? "");
      if (noteRow(db, id)) return { type: "note", ...(await call("get_note", { noteId: id }) as Args) };
      if (cardRow(db, id)) return { type: "task", ...(await call("get_task", { cardId: id }) as Args) };
      return { error: `No note or task with id "${id}"` };
    }

    case "search_notes": {
      if (args.mode === "semantic") {
        const workspaceId = resolveWorkspaceId(db, opts, { projectId: args.projectId });
        if (!workspaceId) return { error: "No workspace found" };
        const limit = typeof args.limit === "number" ? args.limit : 10;
        const filtered = args.projectId || args.folder !== undefined || args.type;
        // Over-fetch when filtering so the filter doesn't starve the result.
        const res = await call("search_notes_semantic", { workspaceId, query: args.query, k: Math.min(100, filtered ? limit * 4 : limit) }) as Args;
        if (isErr(res) || !filtered || !Array.isArray(res?.results)) return res;
        const keep = notesMatching(db, res.results.map((r: Args) => r.noteId), args);
        return { ...res, results: res.results.filter((r: Args) => keep.has(r.noteId)).slice(0, limit) };
      }
      return call("search_notes", args);
    }

    case "search_tasks": {
      const limit = typeof args.limit === "number" ? args.limit : 10;
      if (args.mode === "semantic") {
        const workspaceId = resolveWorkspaceId(db, opts, { projectId: args.projectId });
        if (!workspaceId) return { error: "No workspace found" };
        return call("search_tasks_semantic", { workspaceId, query: args.query, k: Math.min(100, limit) });
      }
      if (!args.filter) return call("search_tasks", args);
      const res = args.filter === "ready" ? await call("list_ready_tasks", { projectId: args.projectId })
        : args.filter === "overdue" ? await call("list_overdue_tasks", { projectId: args.projectId })
        : await call("list_tasks_due", { projectId: args.projectId, days: args.dueWithinDays });
      if (isErr(res) || !Array.isArray(res)) return res;
      const q = String(args.query ?? "").trim().toLowerCase();
      let cards = res as Args[];
      if (q) cards = cards.filter((c) => q.split(/\s+/).every((t) => String(c.title ?? "").toLowerCase().includes(t)));
      if (args.columnType) cards = cards.filter((c) => c.columnType === undefined || c.columnType === args.columnType);
      if (args.assignee || args.tag) {
        const keep = cardsMatching(db, cards.map((c) => c.id), args);
        cards = cards.filter((c) => keep.has(c.id));
      }
      return cards.slice(0, limit);
    }

    case "ensure_note": {
      if (!args.templateId) return call("ensure_note", args);
      const created = await call("instantiate_template", {
        projectId: args.projectId, templateId: args.templateId, title: args.title, folder: args.folder,
      }) as Args;
      if (isErr(created) || (!args.tagNames && args.isPinned === undefined)) return created;
      const tagged = await call("ensure_note", { projectId: args.projectId, title: created.title, tagNames: args.tagNames, isPinned: args.isPinned });
      return isErr(tagged) ? { ...created, error: tagged.error } : created;
    }

    case "edit_note":
      return typeof args.oldString === "string" && args.oldString.length > 0
        ? call("patch_note", { noteId: args.noteId, oldString: args.oldString, newString: args.newString, replaceAll: args.replaceAll })
        : call("append_to_note", { noteId: args.noteId, content: args.newString });

    case "update_notes": {
      const ids = list(args.noteIds);
      if (ids.length === 0) return { error: "noteIds is required" };
      if (args.title !== undefined && ids.length > 1) return { error: "title (rename) applies to a single note — pass one noteId" };
      const errors: string[] = [];
      const step = async (label: string, n: string, a: Args) => {
        const r = await call(n, a);
        if (isErr(r)) errors.push(`${label}: ${r.error}`);
        return r;
      };
      if (args.title !== undefined) await step(`rename ${ids[0]}`, "rename_note", { noteId: ids[0], newTitle: args.title });
      if (args.folder !== undefined) await step("move", "bulk_move_notes", { noteIds: ids, folder: args.folder });
      for (const id of ids) {
        if (list(args.tagNames).length > 0) await step(`tag ${id}`, "tag_note", { noteId: id, tagNames: list(args.tagNames), mode: args.tagMode ?? "add" });
        if (args.isPinned !== undefined) {
          const row = noteRow(db, id);
          if (!row) errors.push(`pin ${id}: Note not found`);
          else await step(`pin ${id}`, "ensure_note", { projectId: row.projectId, title: row.title, isPinned: args.isPinned });
        }
        for (const cardId of list(args.linkCardIds)) await step(`link ${id}→${cardId}`, "link_note_to_task", { noteId: id, cardId });
        for (const cardId of list(args.unlinkCardIds)) await step(`unlink ${id}→${cardId}`, "unlink_note_from_task", { noteId: id, cardId });
      }
      const notes = ids.map((id) => noteRow(db, id)).filter(Boolean).map((n) => ({ id: n!.id, title: n!.title }));
      // A single note keeps the {id,title} top-level shape so chips can open it.
      return summarize(notes.length === 1 ? { ...notes[0], updated: true } : { updated: notes }, errors);
    }

    case "create_task": {
      let columnId = args.columnId as string | undefined;
      if (!columnId) {
        columnId = columnOfType(db, args.projectId, args.columnType ?? "backlog") ?? firstColumn(db, args.projectId);
        if (!columnId) return { error: `Project ${args.projectId} has no board columns` };
      }
      const { columnType: _ct, linkNoteIds: _l, ...rest } = args;
      const card = await call("create_task", { ...rest, columnId }) as Args;
      if (isErr(card)) return card;
      const errors: string[] = [];
      for (const noteId of list(args.linkNoteIds)) {
        const r = await call("link_note_to_task", { noteId, cardId: card.id });
        if (isErr(r)) errors.push(`link ${noteId}: ${r.error}`);
      }
      return summarize(card, errors);
    }

    case "update_tasks": {
      const ids = list(args.cardIds);
      if (ids.length === 0) return { error: "cardIds is required" };
      const errors: string[] = [];
      const step = async (label: string, n: string, a: Args) => {
        const r = await call(n, a);
        if (isErr(r)) errors.push(`${label}: ${r.error}`);
        return r;
      };
      const scalar: Args = {};
      for (const k of ["title", "description", "priority", "dueDate", "assignee", "archived"]) {
        if (args[k] !== undefined) scalar[k] = args[k];
      }
      for (const id of ids) {
        const card = cardRow(db, id);
        if (!card) { errors.push(`${id}: Task not found`); continue; }
        let columnId = args.columnId as string | undefined;
        if (!columnId && args.columnType) {
          columnId = columnOfType(db, card.projectId, args.columnType);
          if (!columnId) { errors.push(`${id}: no ${args.columnType} column in its project`); }
        }
        if (Object.keys(scalar).length > 0 || columnId) {
          await step(id, "update_task", { cardId: id, ...scalar, ...(columnId ? { columnId } : {}) });
        }
        for (const b of list(args.blockedBy)) await step(`block ${id} on ${b}`, "update_task", { cardId: id, blockedBy: b });
        for (const b of list(args.unblockFrom)) await step(`unblock ${id} from ${b}`, "update_task", { cardId: id, unblockFrom: b });
        if (list(args.tagNames).length > 0) await step(`tag ${id}`, "tag_task", { cardId: id, tagNames: list(args.tagNames), mode: args.tagMode ?? "add" });
        for (const noteId of list(args.linkNoteIds)) await step(`link ${noteId}→${id}`, "link_note_to_task", { noteId, cardId: id });
        for (const noteId of list(args.unlinkNoteIds)) await step(`unlink ${noteId}→${id}`, "unlink_note_from_task", { noteId, cardId: id });
      }
      const cards = ids.map((id) => cardRow(db, id)).filter(Boolean).map((c) => ({ id: c!.id, title: c!.title, columnId: c!.columnId }));
      return summarize(cards.length === 1 ? { ...cards[0], updated: true } : { updated: cards }, errors);
    }

    case "task_progress":
      if (args.action === "claim") {
        return call("claim_task", { cardId: args.cardId, agent: args.agent ?? "Agent", force: args.force });
      }
      if (!args.message) return { error: "message is required for action 'log'" };
      return call("add_task_progress", { cardId: args.cardId, message: args.message, agent: args.agent, moveTo: args.moveTo });

    case "delete": {
      const id = args.id;
      switch (args.type) {
        case "note":      return call("delete_note", { noteId: id });
        case "task":      return call("delete_task", { cardId: id });
        case "project":   return call("delete_project", { projectId: id });
        case "flow_node": return call("delete_idea_flow_node", { nodeId: id });
        case "flow_edge": return call("delete_idea_flow_edge", { edgeId: id });
        default:          return { error: `Unknown delete type "${args.type}"` };
      }
    }

    case "edit_idea_flow": {
      const ops = Array.isArray(args.ops) ? args.ops as Args[] : [];
      const refs: Record<string, string> = {};
      const resolve = (v: unknown) => (typeof v === "string" && refs[v]) ? refs[v] : v;
      const results: Args[] = [];
      const errors: string[] = [];
      for (const [i, op] of ops.entries()) {
        let r: unknown;
        switch (op.op) {
          case "add_node": {
            // Models sometimes nest the node type inside data, or leave it out for
            // a plain {title, body} thought — accept either place, default "idea".
            const { type: dataType, ...data } = (op.data ?? {}) as Args;
            r = await call("create_idea_flow_node", {
              projectId: args.projectId, type: op.type ?? dataType ?? "idea", data: op.type ? op.data : data,
              x: op.x, y: op.y, width: op.width, height: op.height, parentId: resolve(op.parentId),
            });
            if (!isErr(r) && typeof op.ref === "string" && (r as Args).id) refs[op.ref] = (r as Args).id;
            break;
          }
          case "update_node":
            r = await call("update_idea_flow_node", { nodeId: resolve(op.nodeId), data: op.data, x: op.x, y: op.y, width: op.width, height: op.height });
            break;
          case "add_edge":
            r = await call("create_idea_flow_edge", {
              sourceNodeId: resolve(op.source ?? op.sourceNodeId), targetNodeId: resolve(op.target ?? op.targetNodeId), label: op.label,
            });
            break;
          case "delete_node":
            r = await call("delete_idea_flow_node", { nodeId: resolve(op.nodeId) });
            break;
          case "delete_edge":
            r = await call("delete_idea_flow_edge", { edgeId: op.edgeId });
            break;
          default:
            r = { error: `Unknown op "${op.op}"` };
        }
        if (isErr(r)) errors.push(`op ${i} (${op.op}): ${r.error}`);
        results.push({ op: op.op, ...(op.ref ? { ref: op.ref } : {}), ...(isErr(r) ? { error: r.error } : { id: (r as Args)?.id }) });
      }
      let layout: unknown;
      if (args.layout) {
        layout = await call("layout_idea_flow", { projectId: args.projectId, direction: args.layout });
        if (isErr(layout)) errors.push(`layout: ${layout.error}`);
      }
      return summarize({ results, refs, ...(args.layout ? { layout: isErr(layout) ? undefined : "done" } : {}) }, errors);
    }

    case "get_graph": {
      const workspaceId = resolveWorkspaceId(db, opts, { nodeId: args.nodeId, projectId: list(args.projectIds)[0] });
      if (!workspaceId) return { error: "No workspace found" };
      if (args.nodeId && args.semantic) return call("get_semantic_neighbors", { workspaceId, noteId: args.nodeId });
      if (args.nodeId) return call("get_neighbors", { workspaceId, nodeId: args.nodeId, depth: args.depth, edgeTypes: args.edgeTypes });
      return call("get_knowledge_graph", {
        workspaceId, projectIds: args.projectIds, includeAuto: args.includeAuto, nodeTypes: args.nodeTypes, edgeTypes: args.edgeTypes,
      });
    }

    case "codebase_query":
      switch (args.action) {
        case "search":     return call("codebase_search_symbols", { query: args.query, folder: args.folder, limit: args.limit });
        case "definition": return call("codebase_get_symbol_definition", { name: args.query, folder: args.folder });
        case "references": return call("codebase_get_references", { name: args.query, folder: args.folder });
        case "file":       return call("codebase_get_file_symbols", { filePath: args.query });
        default:           return { error: `Unknown codebase_query action "${args.action}"` };
      }

    default:
      return { error: `Unknown tool: ${name}` };
  }
}
