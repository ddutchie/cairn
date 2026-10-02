import { prettifyToolLabel } from "../../shared/ui/constants";

export type ToolArgs = Record<string, unknown>;

/** Argument keys that name what a connector call acts on, most specific first. */
const CONNECTOR_TARGET_KEYS = [
  "title", "name", "summary", "subject", "query", "jql", "cql", "q",
  "issueKey", "issueIdOrKey", "pageId", "key", "id", "url", "path", "channel",
];

/** The one argument worth showing inline for a connector call (never an arg dump). */
function connectorTarget(args: ToolArgs): string | undefined {
  for (const key of CONNECTOR_TARGET_KEYS) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return value;
    if (typeof value === "number") return String(value);
  }
  return undefined;
}

export interface HumanizedTool {
  pre: string;
  obj?: string;
  post?: string;
}

const MAX_OBJECT_LENGTH = 160;

function short(value: unknown, fallback = "this item"): string {
  if (typeof value !== "string" || !value.trim()) return fallback;
  const text = value.trim();
  return text.length > MAX_OBJECT_LENGTH ? `${text.slice(0, MAX_OBJECT_LENGTH - 1)}…` : text;
}

/**
 * Resolves Cairn entity ids to display names (notes, tasks, projects, board
 * columns). Returns undefined for an unknown id, in which case the raw id is
 * shown, as before.
 */
export interface CairnNameLookup {
  note?: (id: string) => string | undefined;
  task?: (id: string) => string | undefined;
  project?: (id: string) => string | undefined;
  column?: (id: string) => string | undefined;
}

/** The display label an idea-flow node call carries in its `data`, if any. */
function nodeLabel(data: unknown): string | undefined {
  if (!data || typeof data !== "object") return undefined;
  const d = data as Record<string, unknown>;
  for (const key of ["label", "title", "text", "name"]) {
    if (typeof d[key] === "string" && (d[key] as string).trim()) return d[key] as string;
  }
  return undefined;
}

/** Convert a tool event into a short, human-readable transcript sentence. */
export function humanizeTool(name: string, args: ToolArgs = {}, lookup: CairnNameLookup = {}): HumanizedTool {
  const named = (kind: keyof CairnNameLookup, id: unknown, fallback: string): string => {
    if (typeof id !== "string" || !id.trim()) return fallback;
    const resolved = lookup[kind]?.(id.trim());
    return short(resolved && resolved.trim() ? resolved : id);
  };
  const note = (fallback = "a note") => named("note", args.noteId, fallback);
  const task = (fallback = "a task") => named("task", args.cardId, fallback);
  const count = (value: unknown, noun: string) => Array.isArray(value) ? `${value.length} ${noun}${value.length === 1 ? "" : "s"}` : `${noun}s`;
  switch (name) {
    case "read": return { pre: "Read", obj: short(args.path) };
    case "write": return { pre: "Wrote", obj: short(args.path) };
    case "edit": return { pre: "Edited", obj: short(args.path) };
    case "grep": return { pre: "Searched the code for", obj: `“${short(args.pattern, "a pattern")}”` };
    case "find": return { pre: "Found files matching", obj: `“${short(args.pattern, "a pattern")}”` };
    case "ls": return { pre: "Listed", obj: short(args.path, "the current folder") };
    case "bash":
    case "pwsh": return typeof args.description === "string" && args.description.trim()
      ? { pre: short(args.description) }
      : { pre: "Ran", obj: short(args.command, "a command") };
    case "skill": return { pre: "Loaded skill", obj: short(args.name, "a skill") };
    case "todo_write": return { pre: "Updated the plan", obj: short(args.todos, "the task list") };
    // ── Cairn notes ──
    case "create_note": return { pre: "Created note", obj: short(args.title) };
    case "ensure_note": return { pre: "Saved note", obj: short(args.title) };
    case "get_note": return { pre: "Read note", obj: note() };
    case "patch_note": return { pre: "Updated note", obj: note() };
    case "append_to_note": return { pre: "Added to note", obj: note() };
    case "rename_note": return typeof args.newTitle === "string" && args.newTitle.trim()
      ? { pre: "Renamed note", obj: note(), post: `to “${short(args.newTitle)}”` }
      : { pre: "Renamed note", obj: note() };
    case "delete_note": return { pre: "Deleted note", obj: note() };
    case "tag_note": return { pre: "Tagged note", obj: note() };
    case "bulk_move_notes": return { pre: "Moved", obj: count(args.noteIds, "note"), post: typeof args.folder === "string" && args.folder.trim() ? `to ${short(args.folder)}` : undefined };
    case "spawn_tasks_from_note": return { pre: "Created tasks from note", obj: note() };
    case "update_dashboard": return { pre: "Updated dashboard", obj: typeof args.title === "string" && args.title.trim() ? short(args.title) : note("a dashboard") };
    case "create_dashboard": return { pre: "Created dashboard", obj: short(args.title, "a dashboard") };
    case "instantiate_template": return { pre: "Created note from template", obj: short(args.title ?? args.templateName, "a template") };
    // ── Cairn tasks ──
    case "create_task": return { pre: "Created task", obj: short(args.title) };
    case "get_task": return { pre: "Read task", obj: task() };
    case "update_task": {
      const target = task();
      const column = typeof args.columnId === "string" ? lookup.column?.(args.columnId) : undefined;
      if (column) return { pre: "Moved task", obj: target, post: `to ${short(column)}` };
      if (typeof args.title === "string" && args.title.trim() && typeof args.cardId === "string" && lookup.task?.(args.cardId) && lookup.task(args.cardId) !== args.title) {
        return { pre: "Renamed task", obj: target, post: `to “${short(args.title)}”` };
      }
      return { pre: "Updated task", obj: target };
    }
    case "delete_task": return { pre: "Deleted task", obj: task() };
    case "tag_task": return { pre: "Tagged task", obj: task() };
    case "bulk_update_task_status": {
      const column = typeof args.targetColumnId === "string" ? lookup.column?.(args.targetColumnId) : undefined;
      return { pre: "Moved", obj: count(args.cardIds, "task"), post: column ? `to ${short(column)}` : undefined };
    }
    case "link_note_to_task": return { pre: "Linked note", obj: note(), post: `to ${task()}` };
    case "unlink_note_from_task": return { pre: "Unlinked note", obj: note(), post: `from ${task()}` };
    // ── Cairn projects / tags / idea flow ──
    case "upsert_project": return typeof args.projectId === "string" && args.projectId.trim()
      ? { pre: "Updated project", obj: typeof args.name === "string" && args.name.trim() ? short(args.name) : named("project", args.projectId, "a project") }
      : { pre: "Created project", obj: short(args.name, "a project") };
    case "delete_project": return { pre: "Deleted project", obj: named("project", args.projectId, "a project") };
    case "create_tag": return { pre: "Created tag", obj: short(args.name, "a tag") };
    // Idea-flow nodes aren't in the renderer store — use the label the call carries.
    case "create_idea_flow_node": return nodeLabel(args.data) ? { pre: "Added idea", obj: short(nodeLabel(args.data)) } : { pre: "Added an idea flow node" };
    case "update_idea_flow_node": return nodeLabel(args.data) ? { pre: "Updated idea", obj: short(nodeLabel(args.data)) } : { pre: "Updated an idea flow node" };
    case "delete_idea_flow_node": return { pre: "Deleted an idea flow node" };
    case "create_idea_flow_edge": return { pre: "Connected two ideas", post: typeof args.label === "string" && args.label.trim() ? `(“${short(args.label)}”)` : undefined };
    case "delete_idea_flow_edge": return { pre: "Removed an idea flow connection" };
    case "layout_idea_flow": {
      const project = typeof args.projectId === "string" ? lookup.project?.(args.projectId) : undefined;
      return project ? { pre: "Re-laid out the idea flow for", obj: short(project) } : { pre: "Re-laid out the idea flow" };
    }
    case "generate_prd": return { pre: "Drafted PRD", obj: short(args.title, "a plan") };
    case "search_notes": return { pre: "Searched notes for", obj: `“${short(args.query, "a phrase")}”` };
    case "search_tasks": return { pre: "Searched tasks for", obj: `“${short(args.query, "a phrase")}”` };
    default: {
      if (/^(?:mcp|svc)__/.test(name)) return humanizeConnectorAction(name, args);
      return { pre: "Used", obj: short(name, "a tool") };
    }
  }
}

/** "Create confluence page" + its target — the action, not "Used <tool>". Accepts
 *  namespaced (`mcp__id__tool`) and bare (`send_message`) connector tool names. */
function humanizeConnectorAction(name: string, args: ToolArgs): HumanizedTool {
  const pre = prettifyToolLabel(name, { prettifyBare: true });
  const target = connectorTarget(args);
  return target ? { pre, obj: short(target) } : { pre };
}

/**
 * Connector-call summary shown next to the connector's own name: drop that
 * name from the action so "Confluence · Create confluence page" reads
 * "Confluence · Create page". Whole-word, case-insensitive; keeps the
 * original when stripping would leave nothing.
 */
export function humanizeConnectorTool(name: string, args: ToolArgs = {}, connectorLabel?: string): HumanizedTool {
  // The caller already knows this is a connector call, so a bare tool name
  // (e.g. an HTTP service's `send_message`) is humanized as an action too.
  const result = humanizeConnectorAction(name, args);
  const label = connectorLabel?.trim();
  if (!label) return result;
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  const stripped = result.pre.replace(new RegExp(`(^|\\s)${escaped}(?=\\s|$)`, "gi"), "$1").replace(/\s+/g, " ").trim();
  if (!stripped) return result;
  return { ...result, pre: stripped.charAt(0).toUpperCase() + stripped.slice(1) };
}

export function humanizedText(name: string, args?: ToolArgs, lookup?: CairnNameLookup): string {
  const result = humanizeTool(name, args, lookup);
  return [result.pre, result.obj, result.post].filter(Boolean).join(" ");
}
