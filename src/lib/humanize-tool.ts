export type ToolArgs = Record<string, unknown>;

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

function externalTarget(name: string): string {
  const match = /^(?:mcp|svc)__([^_]+)__(.+)$/.exec(name);
  return match ? match[1] : "connected service";
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
    case "bash": return typeof args.description === "string" && args.description.trim()
      ? { pre: short(args.description) }
      : { pre: "Ran", obj: short(args.command, "a command") };
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
        return { pre: "Used", obj: `${externalTarget(name)} · ${short(name.split("__").pop(), "a tool")}` };
      }
      return { pre: "Used", obj: short(name, "a tool") };
    }
  }
}

export function humanizedText(name: string, args?: ToolArgs): string {
  const result = humanizeTool(name, args);
  return [result.pre, result.obj, result.post].filter(Boolean).join(" ");
}
