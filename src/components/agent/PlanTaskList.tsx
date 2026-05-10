"use client";

import React, { useMemo, useState } from "react";
import { CheckSquare, Square, ChevronDown, ChevronUp } from "lucide-react";
import { cn } from "@/lib/utils";

interface PlanTask {
  label: string;
  checked: boolean;
}

/** Parse `- [ ] …` and `- [x] …` lines from the `## Tasks` section of a PRD note. */
function parseTasks(content: string): PlanTask[] {
  const tasks: PlanTask[] = [];
  // Match from "## Tasks" to the next level-2 heading or end of string.
  // Note: \z is not valid in JS regex — we match greedily then truncate at the next heading.
  const taskSectionMatch = content.match(/^##\s+Tasks\s*\n([\s\S]*)/m);
  if (!taskSectionMatch) return tasks;
  const nextHeading = taskSectionMatch[1].search(/^##\s/m);
  const section = nextHeading !== -1
    ? taskSectionMatch[1].slice(0, nextHeading)
    : taskSectionMatch[1];
  for (const line of section.split("\n")) {
    const m = line.match(/^[-*]\s+\[([x ])\]\s+(.*)/i);
    if (m) {
      tasks.push({ checked: m[1].toLowerCase() === "x", label: m[2].trim() });
    }
  }
  return tasks;
}

interface PlanTaskListProps {
  content: string;
}

export function PlanTaskList({ content }: PlanTaskListProps) {
  const [expanded, setExpanded] = useState(false);
  const tasks = useMemo(() => parseTasks(content), [content]);

  if (tasks.length === 0) return null;

  const doneCount = tasks.filter((t) => t.checked).length;
  const total = tasks.length;
  const progress = total > 0 ? doneCount / total : 0;

  return (
    <div className="border-b border-[var(--border)] bg-[var(--surface)] flex-shrink-0">
      {/* Task rows — expand upward above the summary bar */}
      {expanded && (
        <div className="px-3 pt-2 pb-1 flex flex-col gap-0.5 max-h-52 overflow-y-auto">
          {tasks.map((task, i) => (
            <div key={i} className="flex items-start gap-2 py-0.5">
              {task.checked
                ? <CheckSquare size={12} className="text-[var(--accent)] shrink-0 mt-px" />
                : <Square      size={12} className="text-[var(--text-tertiary)] shrink-0 mt-px" />
              }
              <span
                className={cn(
                  "text-[0.714rem] leading-relaxed",
                  task.checked
                    ? "line-through text-[var(--text-tertiary)]"
                    : "text-[var(--text-secondary)]",
                )}
              >
                {task.label}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Progress bar — always visible above the toggle row */}
      <div className="h-px bg-[var(--border)] mx-3">
        <div
          className="h-full bg-[var(--accent)] rounded-full transition-all duration-500"
          style={{ width: `${progress * 100}%` }}
        />
      </div>

      {/* Summary / toggle row — always visible, pinned at bottom */}
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-[var(--surface-2)] transition-colors text-left"
      >
        <span className="text-[0.714rem] font-medium text-[var(--text-secondary)] flex-1">
          {doneCount} of {total} task{total !== 1 ? "s" : ""} completed
        </span>
        {expanded
          ? <ChevronDown size={10} className="text-[var(--text-tertiary)] shrink-0" />
          : <ChevronUp   size={10} className="text-[var(--text-tertiary)] shrink-0" />
        }
      </button>
    </div>
  );
}
