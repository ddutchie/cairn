"use client";

/**
 * AgentTodoDock — collapsible todo list for a coding-agent session.
 *
 * Rendered above the input area in AgentChatPane. Data comes from the
 * `todowrite` tool (via pi-agent:todos IPC events + SQLite). Mirrors opencode's
 * SessionTodoDock: a compact summary line ([3/5 todos - Current task]) that
 * expands to the full checklist. Status is derived purely from each todo's
 * `status` field.
 */

import { useMemo, useState } from "react";
import { ChevronDown, ChevronUp, Check, Minus } from "lucide-react";
import { cn } from "@/lib/utils";
import type { PiTodo } from "@/types";

interface AgentTodoDockProps {
  todos: PiTodo[];
  live?: boolean;
}

function statusIcon(status: PiTodo["status"]) {
  if (status === "completed" || status === "cancelled") return <Check size={12} className="shrink-0 mt-px" />;
  if (status === "in_progress") return <Minus size={12} className="shrink-0 mt-px" />;
  return <span className="w-3 h-3 rounded-full border border-[var(--text-tertiary)] shrink-0 mt-px box-border" />;
}

export function AgentTodoDock({ todos, live = true }: AgentTodoDockProps) {
  const [expanded, setExpanded] = useState(false);

  const done = useMemo(() => todos.filter((t) => t.status === "completed" || t.status === "cancelled").length, [todos]);
  const total = todos.length;

  const active = useMemo(
    () =>
      todos.find((t) => t.status === "in_progress") ??
      todos.find((t) => t.status === "pending") ??
      todos.filter((t) => t.status === "completed" || t.status === "cancelled").at(-1) ??
      todos[0],
    [todos],
  );

  if (total === 0) return null;

  const summary = `[${done}/${total} todos${active ? ` - ${active.content}` : ""}]`;

  return (
    <div className="border-b border-[var(--border)] bg-[var(--surface)] flex-shrink-0">
      {/* Expanded list — upward from the summary bar */}
      {expanded && (
        <div className="px-3 pt-2 pb-1 flex flex-col gap-0.5 max-h-52 overflow-y-auto">
          {todos.map((todo, i) => (
            <div key={i} className="flex items-start gap-2 py-0.5">
              <span
                className={cn(
                  "flex items-center justify-center w-3.5 h-3.5 rounded-sm shrink-0 mt-px",
                  todo.status === "completed" || todo.status === "cancelled"
                    ? "bg-[var(--accent)] text-[var(--accent-fg)]"
                    : todo.status === "in_progress"
                      ? "text-[var(--accent)]"
                      : "text-[var(--text-tertiary)]",
                )}
              >
                {statusIcon(todo.status)}
              </span>
              <span
                className={cn(
                  "text-[0.714rem] leading-relaxed",
                  todo.status === "completed" || todo.status === "cancelled"
                    ? "line-through text-[var(--text-tertiary)]"
                    : todo.status === "in_progress"
                      ? "text-[var(--text-primary)] font-medium"
                      : "text-[var(--text-secondary)]",
                )}
              >
                {todo.content}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Summary / toggle row — always visible */}
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-[var(--surface-2)] transition-colors text-left"
        title={expanded ? "Collapse todos" : "Expand todos"}
      >
        <span
          className={cn(
            "text-[0.714rem] font-medium flex-1 truncate",
            live ? "text-[var(--text-secondary)]" : "text-[var(--text-tertiary)]",
          )}
        >
          {summary}
        </span>
        <span
          className={cn(
            "h-1 w-8 rounded-full bg-[var(--border)] overflow-hidden shrink-0",
            total > 0 && "relative",
          )}
        >
          <span
            className="absolute inset-y-0 left-0 bg-[var(--accent)] rounded-full transition-all duration-500"
            style={{ width: `${total > 0 ? (done / total) * 100 : 0}%` }}
          />
        </span>
        {expanded
          ? <ChevronDown size={10} className="text-[var(--text-tertiary)] shrink-0" />
          : <ChevronUp   size={10} className="text-[var(--text-tertiary)] shrink-0" />}
      </button>
    </div>
  );
}
