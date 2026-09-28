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

/** Convert a tool event into a short, human-readable transcript sentence. */
export function humanizeTool(name: string, args: ToolArgs = {}): HumanizedTool {
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
    case "create_note": return { pre: "Created note", obj: short(args.title) };
    case "ensure_note": return { pre: "Saved note", obj: short(args.title) };
    case "patch_note": return { pre: "Updated note", obj: short(args.noteId) };
    case "append_to_note": return { pre: "Added to note", obj: short(args.noteId) };
    case "create_task": return { pre: "Created task", obj: short(args.title) };
    case "update_task": return { pre: "Updated task", obj: short(args.title ?? args.cardId) };
    case "search_notes": return { pre: "Searched notes for", obj: `“${short(args.query, "a phrase")}”` };
    case "search_tasks": return { pre: "Searched tasks for", obj: `“${short(args.query, "a phrase")}”` };
    default: {
      if (/^(?:mcp|svc)__/.test(name)) {
        // "Create confluence page" + its title — the action, not "Used <tool>".
        const target = connectorTarget(args);
        return target ? { pre: prettifyToolLabel(name), obj: short(target) } : { pre: prettifyToolLabel(name) };
      }
      return { pre: "Used", obj: short(name, "a tool") };
    }
  }
}

/**
 * Connector-call summary shown next to the connector's own name: drop that
 * name from the action so "Confluence · Create confluence page" reads
 * "Confluence · Create page". Whole-word, case-insensitive; keeps the
 * original when stripping would leave nothing.
 */
export function humanizeConnectorTool(name: string, args: ToolArgs = {}, connectorLabel?: string): HumanizedTool {
  const result = humanizeTool(name, args);
  const label = connectorLabel?.trim();
  if (!label) return result;
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  const stripped = result.pre.replace(new RegExp(`(^|\\s)${escaped}(?=\\s|$)`, "gi"), "$1").replace(/\s+/g, " ").trim();
  if (!stripped) return result;
  return { ...result, pre: stripped.charAt(0).toUpperCase() + stripped.slice(1) };
}

export function humanizedText(name: string, args?: ToolArgs): string {
  const result = humanizeTool(name, args);
  return [result.pre, result.obj, result.post].filter(Boolean).join(" ");
}
