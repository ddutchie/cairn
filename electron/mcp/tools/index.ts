import Database from "better-sqlite3";
import { getSnapshot } from "../db";
import { getCairnContext, getProjectContextPack, DASHBOARD_CONSTANTS, IDEA_FLOW_RULES } from "./metadata";
import { create_tag, tag_note, tag_task } from "./tags";
import { upsert_project, delete_project } from "./projects";
import { get_note, search_notes, ensure_note, append_to_note, patch_note, delete_note, rename_note, bulk_move_notes, list_folders, instantiate_template, list_templates } from "./notes";
import { get_task, search_tasks, create_task, bulk_update_task_status, link_note_to_task, unlink_note_from_task, delete_task, list_ready_tasks, list_overdue_tasks, list_tasks_due, update_task } from "./tasks";
import { create_dashboard, update_dashboard } from "./dashboards";
import {
  get_idea_flow,
  create_idea_flow_node,
  update_idea_flow_node,
  delete_idea_flow_node,
  create_idea_flow_edge,
  delete_idea_flow_edge,
  layout_idea_flow
} from "./flow";
import { get_knowledge_graph, get_neighbors, get_semantic_neighbors, search_notes_semantic, search_tasks_semantic } from "./graph";
import {
  codebase_reindex,
  codebase_search_symbols,
  codebase_get_symbol_definition,
  codebase_get_references,
  codebase_get_file_symbols
} from "./codebase";
import { getUserStyle, appendUserStyleObservation } from "../../db/queries";
import {
  RELATIONSHIP_AFFECTING_TOOLS,
  collectEntityIds,
  collectPreDeleteEntityIds,
  refreshRelationshipsFor,
} from "./relationships";

/**
 * Execute one MCP tool.
 *
 * Wraps `dispatchTool` so that any tool which mutates a note or card also
 * refreshes the derived `relationship_cache`. The Electron IPC write path does
 * this on every mutation; without it here, MCP-side writes leave the knowledge
 * graph's auto-edges describing the previous state of the workspace (a
 * DB-persisted staleness that outlives an MCP restart).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function executeTool(db: Database.Database, workspacePath: string, toolName: string, args: Record<string, any>): unknown {
  // Some tools (delete_project) destroy the rows whose cache we must invalidate,
  // so capture those ids BEFORE dispatch — they're unrecoverable afterwards.
  const preDeleteIds = RELATIONSHIP_AFFECTING_TOOLS.has(toolName)
    ? collectPreDeleteEntityIds(db, toolName, args)
    : [];

  const result = dispatchTool(db, workspacePath, toolName, args);

  if (RELATIONSHIP_AFFECTING_TOOLS.has(toolName)) {
    const failed = typeof result === "object" && result !== null && "error" in result;
    if (!failed) {
      refreshRelationshipsFor(db, [...preDeleteIds, ...collectEntityIds(args, result)]);
    }
  }

  return result;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function dispatchTool(db: Database.Database, workspacePath: string, toolName: string, args: Record<string, any>): unknown {
  const snap = getSnapshot(db);

  switch (toolName) {
    case "get_cairn_context":
      return getCairnContext(db, snap, args, workspacePath);

    case "get_project_context_pack":
      return getProjectContextPack(db, snap, args);

    case "search_notes":
      return search_notes(db, snap, args);

    case "search_tasks":
      return search_tasks(db, snap, args);

    case "create_dashboard":
      return create_dashboard(db, snap, args);

    case "update_dashboard":
      return update_dashboard(db, snap, args);

    case "get_dashboard_constants":
      return DASHBOARD_CONSTANTS;

    case "get_idea_flow_rules":
      return IDEA_FLOW_RULES;

    case "create_task":
      return create_task(db, snap, args);

    case "bulk_update_task_status":
      return bulk_update_task_status(db, snap, args);

    case "link_note_to_task":
      return link_note_to_task(db, snap, workspacePath, args);

    case "unlink_note_from_task":
      return unlink_note_from_task(db, snap, workspacePath, args);

    case "get_note":
      return get_note(db, snap, args);

    case "upsert_project":
      return upsert_project(db, snap, workspacePath, args);

    case "get_task":
      return get_task(db, snap, args);

    case "delete_note":
      return delete_note(db, snap, workspacePath, args);

    case "delete_task":
      return delete_task(db, snap, args);

    case "list_ready_tasks":
      return list_ready_tasks(db, snap, args);

    case "list_overdue_tasks":
      return list_overdue_tasks(db, snap, args);

    case "list_tasks_due":
      return list_tasks_due(db, snap, args);

    case "update_task":
      return update_task(db, snap, args);

    case "create_tag":
      return create_tag(db, args);

    case "tag_note":
      return tag_note(db, args);

    case "tag_task":
      return tag_task(db, args);

    case "delete_project":
      return delete_project(db, snap, workspacePath, args);

    case "ensure_note":
      return ensure_note(db, snap, workspacePath, args);

    case "append_to_note":
      return append_to_note(db, snap, workspacePath, args);

    case "patch_note":
      return patch_note(db, snap, workspacePath, args);

    case "rename_note":
      return rename_note(db, snap, workspacePath, args);

    case "bulk_move_notes":
      return bulk_move_notes(db, snap, workspacePath, args);

    case "list_folders":
      return list_folders(db, snap, args);

    case "list_templates":
      return list_templates(db, snap, args);

    case "instantiate_template":
      return instantiate_template(db, snap, workspacePath, args);

    case "get_idea_flow":
      return get_idea_flow(db, snap, args);

    case "create_idea_flow_node":
      return create_idea_flow_node(db, snap, args);

    case "update_idea_flow_node":
      return update_idea_flow_node(db, args);

    case "delete_idea_flow_node":
      return delete_idea_flow_node(db, args);

    case "create_idea_flow_edge":
      return create_idea_flow_edge(db, args);

    case "delete_idea_flow_edge":
      return delete_idea_flow_edge(db, args);

    case "layout_idea_flow":
      return layout_idea_flow(db, args);

    case "get_knowledge_graph":
      return get_knowledge_graph(db, args);

    case "get_neighbors":
      return get_neighbors(db, args);

    case "get_semantic_neighbors":
      return get_semantic_neighbors(db, args);

    case "search_notes_semantic":
      return search_notes_semantic(db, args);
    case "search_tasks_semantic":
      return search_tasks_semantic(db, args);

    case "codebase_reindex":
      return codebase_reindex(db, args as Parameters<typeof codebase_reindex>[1]);

    case "codebase_search_symbols":
      return codebase_search_symbols(db, args as Parameters<typeof codebase_search_symbols>[1]);

    case "codebase_get_symbol_definition":
      return codebase_get_symbol_definition(db, args as Parameters<typeof codebase_get_symbol_definition>[1]);

    case "codebase_get_references":
      return codebase_get_references(db, args as Parameters<typeof codebase_get_references>[1]);

    case "codebase_get_file_symbols":
      return codebase_get_file_symbols(db, args as Parameters<typeof codebase_get_file_symbols>[1]);

    case "get_user_writing_style": {
      const mode = (args.mode as "cheatsheet" | "full" | undefined) ?? "cheatsheet";
      const style = getUserStyle(db);
      const configured = !!style && style.source !== "none" && !!(style.fullGuide || style.cheatsheet);
      if (!configured) {
        return {
          configured: false,
          message: "No writing style set up yet — the user hasn't configured one in Settings → Writing Style. Draft in the user's natural, clear voice; do not invent a style guide.",
          mode,
          markdown: null,
          persona: null,
          updatedAt: null,
        };
      }
      return {
        configured: true,
        mode,
        markdown: mode === "full" ? style.fullGuide || style.cheatsheet : style.cheatsheet || style.fullGuide,
        persona: style.persona,
        updatedAt: style.updatedAt,
      };
    }

    case "update_user_writing_style": {
      const mode = args.mode as string | undefined;
      const content = typeof args.content === "string" ? args.content : "";
      const section = typeof args.section === "string" ? args.section : undefined;
      if (mode !== "append") return { error: `Unsupported mode "${mode}" — only "append" is supported.` };
      if (!content.trim()) return { error: "content is required and must be non-empty." };
      if (content.trim().length > 2000) return { error: "content is too long (max 2000 characters)." };
      const { row, updated, reason } = appendUserStyleObservation(db, section, content);
      if (!updated) return { ok: true, updated: false, message: reason ?? "No change.", style: row };
      return { ok: true, updated: true, message: section ? `Appended to "${section}".` : "Appended to the guide.", style: row };
    }

    default:
      return { error: `Unknown tool: ${toolName}` };
  }
}
