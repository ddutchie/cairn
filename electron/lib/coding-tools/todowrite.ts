/**
 * todowrite — coding tool
 *
 * Create and maintain a structured task list for the current agent session.
 * Tracks progress, organises multi-step work, and surfaces status to the user.
 * The model sends the ENTIRE updated list on every call (replace-wholesale),
 * mirroring opencode's todowrite contract — simplest for models, and the
 * returned full list keeps the model's view of the todos correct.
 */

import { saveSessionTodos, type PiSessionTodo } from "../../db/queries";

export interface TodoWriteArgs {
  /** The updated todo list. */
  todos: PiSessionTodo[];
}

export const TODO_STATUSES = ["pending", "in_progress", "completed", "cancelled"] as const;
export const TODO_PRIORITIES = ["high", "medium", "low"] as const;

/** Ported from opencode's todowrite tool description. */
export const TODO_WRITE_DESCRIPTION =
  "Create and maintain a structured task list for the current coding session. " +
  "Tracks progress, organizes multi-step work, and surfaces status to the user.\n\n" +
  "## When to use\n" +
  "Use proactively when:\n" +
  "- The task requires 3+ distinct steps or actions (not just 3 tool calls for a single conceptual step)\n" +
  "- The work is non-trivial and benefits from planning\n" +
  "- The user provides multiple tasks (numbered or comma-separated) or explicitly asks for a todo list\n" +
  "- New instructions arrive — capture them as todos\n" +
  "- You start a task — mark it `in_progress` (only one at a time) before working\n" +
  "- You finish a task — mark it `completed` and add any follow-ups discovered during the work\n\n" +
  "## When NOT to use\n" +
  "Skip when:\n" +
  "- The work is a single, straightforward task (or <3 trivial steps)\n" +
  "- The request is purely informational or conversational\n" +
  "- Tracking adds no organizational value\n\n" +
  "## States\n" +
  "- `pending` — not started\n" +
  "- `in_progress` — actively working (exactly ONE at a time)\n" +
  "- `completed` — finished successfully\n" +
  "- `cancelled` — no longer needed\n\n" +
  "## Rules\n" +
  "- Update status in real time; don't batch completions\n" +
  "- Mark `completed` only after the required work is actually done, including any required verification. Never based on intent.\n" +
  "- Keep exactly one `in_progress` while work remains\n" +
  "- If blocked or partial, keep it `in_progress` and add a follow-up todo describing the blocker\n" +
  "- Preserve user-provided commands verbatim (flags, args, order)\n" +
  "- Items should be specific and actionable; break large work into smaller steps\n\n" +
  "## Examples\n\n" +
  "Use it:\n" +
  "- \"Add a dark mode toggle and run the tests\" -> multi-step feature + explicit verification\n" +
  "- \"Rename getCwd -> getCurrentWorkingDirectory across the repo\" -> grep reveals 15 occurrences in 8 files\n" +
  "- \"Implement registration, catalog, cart, checkout\" -> multiple complex features\n\n" +
  "Skip it:\n" +
  "- \"How do I print Hello World in Python?\" -> informational\n" +
  "- \"Add a comment to calculateTotal\" -> single edit\n" +
  "- \"Run npm install and tell me what happened\" -> one command\n\n" +
  "When in doubt, use it.";

export const todowriteToolDefinition = {
  type: "function" as const,
  function: {
    name: "todowrite",
    description: TODO_WRITE_DESCRIPTION,
    parameters: {
      type: "object",
      properties: {
        todos: {
          type: "array",
          description: "The updated todo list (the FULL list, not a diff)",
          items: {
            type: "object",
            properties: {
              content: { type: "string", description: "Brief description of the task" },
              status: { type: "string", enum: [...TODO_STATUSES], description: "pending, in_progress, completed, or cancelled" },
              priority: { type: "string", enum: [...TODO_PRIORITIES], description: "high, medium, or low" },
            },
            required: ["content", "status", "priority"],
          },
        },
      },
      required: ["todos"],
    },
  },
};

export interface TodoWriteToolContext {
  db: import("better-sqlite3").Database;
  sessionId: string;
}

export async function todowriteTool(args: TodoWriteArgs, ctx: TodoWriteToolContext): Promise<string> {
  const todos = (args.todos ?? []).map((t) => ({
    content: String(t.content ?? ""),
    status: (TODO_STATUSES.includes(t.status as never) ? t.status : "pending") as PiSessionTodo["status"],
    priority: (TODO_PRIORITIES.includes(t.priority as never) ? t.priority : "medium") as PiSessionTodo["priority"],
  }));
  // The tool contract allows exactly ONE in_progress todo at a time — reject a
  // list that violates it so the model re-issues with a single active item
  // rather than silently persisting an ambiguous state.
  const active = todos.filter((t) => t.status === "in_progress").length;
  if (active > 1) {
    return JSON.stringify({ error: `todowrite rejected: ${active} todos are in_progress — exactly one may be active at a time. Re-issue with a single in_progress todo.` });
  }
  saveSessionTodos(ctx.db, ctx.sessionId, todos);
  return JSON.stringify({ todos });
}
