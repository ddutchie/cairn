/** todo_write: the session's working checklist. The latest list replaces the previous one. */
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentTool } from "../tools";
import { ok } from "./schema";

export interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm?: string;
}

export function todoTool(onChange?: (todos: TodoItem[]) => void): AgentTool {
  return defineTool({
    name: "todo_write",
    description: "Maintain a short checklist for multi-step work. Send the full list each time; keep exactly one item in_progress.",
    parameters: Type.Object({
      todos: Type.Array(Type.Object({
        content: Type.String(),
        status: Type.Union([Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("completed")]),
        activeForm: Type.Optional(Type.String({ description: "Present-tense label shown while in progress." })),
      })),
    }),
    // Session-local bookkeeping with no side effects outside the conversation.
    risk: () => ({ class: "READ" }),
    async execute(a) {
      onChange?.(a.todos);
      const done = a.todos.filter((t) => t.status === "completed").length;
      return ok(`Todo list updated (${done}/${a.todos.length} done)`);
    },
  });
}
