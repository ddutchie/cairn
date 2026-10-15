/**
 * Human-readable labels for the mobile tool trail ("Read note X", not
 * "Get item"). Desktop renders the same sentences via humanize-tool.ts; this
 * is the mobile equivalent for its consolidated-only toolset, kept as a pure
 * function (title/project lookups injected) so it is unit-testable without
 * sqlite. Unknown and connector/MCP tools fall back to the prettified raw
 * name, as before.
 */
import { prettifyToolLabel } from "@cairn/shared/ui/constants";

/** Resolves ids to display names; each returns undefined when unknown. */
export interface HumanizeLookup {
  noteTitle?: (id: string) => string | undefined;
  taskTitle?: (id: string) => string | undefined;
  projectName?: (id: string) => string | undefined;
}

/** The note/card a chip opens, when the call produced one. */
export interface HumanizeRef {
  kind: "note" | "card";
  id: string;
}

type Args = Record<string, unknown>;

const str = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));

const strArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.map((x) => str(x)).filter((s) => s.length > 0) : [];

const quoted = (v: unknown, fallback: string): string => {
  const s = str(v).trim();
  return s ? `\u201c${s}\u201d` : fallback;
};

function noteName(lookup: HumanizeLookup, id: string): string {
  return lookup.noteTitle?.(id)?.trim() || id;
}

function taskName(lookup: HumanizeLookup, id: string): string {
  return lookup.taskTitle?.(id)?.trim() || id;
}

/**
 * One-line transcript label for a tool call. `ref` (when the call produced a
 * note/card) decides read labels; titles resolve through `lookup` and fall
 * back to the raw id when the item is gone.
 */
export function humanizeToolCall(
  tool: string,
  args: Args = {},
  ref?: HumanizeRef | null,
  lookup: HumanizeLookup = {},
): string {
  switch (tool) {
    case "get_context": {
      const projectId = str(args.projectId).trim();
      if (!projectId) return "Read workspace context";
      return `Read project context for ${lookup.projectName?.(projectId)?.trim() || projectId}`;
    }
    case "get_item": {
      const id = str(args.id).trim() || ref?.id;
      if (ref?.kind === "card" || (!ref && id && !lookup.noteTitle?.(id) && lookup.taskTitle?.(id))) {
        return `Read task ${id ? taskName(lookup, id) : "a task"}`;
      }
      if (ref?.kind === "note" || id) {
        return `Read note ${id ? noteName(lookup, id) : "a note"}`;
      }
      return "Read item";
    }
    case "search_notes": {
      const q = str(args.query).trim();
      if (!q) return "Listed notes";
      return `${args.mode === "semantic" ? "Searched notes by meaning for" : "Searched notes for"} ${quoted(q, "a phrase")}`;
    }
    case "search_tasks": {
      if (typeof args.filter === "string" && args.filter.trim()) return `Listed ${args.filter.trim()} tasks`;
      const q = str(args.query).trim();
      if (!q) return "Listed tasks";
      return `${args.mode === "semantic" ? "Searched tasks by meaning for" : "Searched tasks for"} ${quoted(q, "a phrase")}`;
    }
    case "ensure_note":
      return `Saved note ${str(args.title).trim() || "a note"}`;
    case "edit_note": {
      const target = str(args.noteId).trim();
      const name = target ? noteName(lookup, target) : "a note";
      return `${typeof args.oldString === "string" && args.oldString ? "Updated note" : "Added to note"} ${name}`;
    }
    case "update_notes": {
      const ids = strArray(args.noteIds);
      const one = ids.length === 1 ? noteName(lookup, ids[0]) : `${ids.length} notes`;
      if (typeof args.title === "string" && args.title.trim()) {
        return `Renamed note ${one} to ${quoted(args.title, "a new title")}`;
      }
      if (typeof args.folder === "string") {
        const folder = str(args.folder).trim();
        return `Moved ${one} to ${folder || "the project root"}`;
      }
      return `Updated ${one}`;
    }
    case "create_task":
      return `Created task ${str(args.title).trim() || "a task"}`;
    case "update_tasks": {
      const ids = strArray(args.cardIds);
      const one = ids.length === 1 ? taskName(lookup, ids[0]) : `${ids.length} tasks`;
      if (typeof args.columnType === "string" && args.columnType.trim()) {
        return `Moved ${one} to ${str(args.columnType).trim().replace(/_/g, " ")}`;
      }
      if (typeof args.columnId === "string" && args.columnId.trim()) return `Moved ${one}`;
      if (args.archived === true) return `Archived ${one}`;
      return `Updated ${one}`;
    }
    case "delete": {
      const kind = args.type === "task" || ref?.kind === "card" ? "task"
        : args.type === "note" || ref?.kind === "note" ? "note" : undefined;
      const id = str(args.id).trim() || ref?.id;
      if (!kind || !id) return "Deleted item";
      const name = kind === "note" ? noteName(lookup, id) : taskName(lookup, id);
      return `Deleted ${kind} ${name}`;
    }
    case "get_user_writing_style":
      return "Read writing style";
    case "update_user_writing_style":
      return "Updated writing style";
    default:
      return prettifyToolLabel(tool, { prettifyBare: true });
  }
}
