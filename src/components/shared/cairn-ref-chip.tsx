"use client";

/**
 * Shared Cairn reference chip + action lookup tables.
 *
 * Used by both `AgentMessageBubble` and `ChatMessageBubble` for rendering the
 * clickable chip that results from a tool call writing a note or task.
 *
 * Previously duplicated byte-for-byte across `agent/AgentMessageBubble.tsx` and
 * `chat/chat-panel/ChatMessageBubble.tsx` (P3-2 of the cleanup plan).
 */

import { FileText, SquareCheck, CheckCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { CairnEvents } from "@/lib/events";
import { useCairnStore } from "@/store";

// ── Action label lookup ──────────────────────────────────────────────────────

export const CAIRN_NOTE_ACTIONS: Record<string, string> = {
  create_note:     "Created note",
  ensure_note:     "Saved note",
  update_note:     "Updated note",
  patch_note:      "Patched note",
  append_to_note:  "Appended to note",
  get_note:        "Read note",
};

export const CAIRN_TASK_ACTIONS: Record<string, string> = {
  create_task:        "Created task",
  update_task:        "Updated task",
  update_task_status: "Moved task",
  get_task:           "Read task",
};

// ── Shared chip component ────────────────────────────────────────────────────

export interface CairnRef {
  type: "note" | "task";
  id: string;
  title: string;
}

export function CairnRefChip({ toolName, cairnRef, ok = true }: {
  /** The MCP tool name — used to look up the action label (e.g. "create_note", "update_task"). */
  toolName: string;
  cairnRef: CairnRef;
  /** When `false`, the chip is styled as failed (non-clickable, danger border). Agent-only. */
  ok?: boolean;
}) {
  const setView = useCairnStore((s) => s.setView);
  const isNote = cairnRef.type === "note";
  const actionLabel = isNote
    ? (CAIRN_NOTE_ACTIONS[toolName] ?? "Updated note")
    : (CAIRN_TASK_ACTIONS[toolName] ?? "Updated task");

  function handleClick() {
    if (isNote) {
      setView("notes");
      // Defer so NotesView has one render cycle to mount its cairn:select-note listener
      setTimeout(() => window.dispatchEvent(CairnEvents.selectNote(cairnRef.id)), 50);
    } else {
      setView("board");
      // Defer so KanbanBoard has one render cycle to mount its cairn:open-card listener
      setTimeout(() => window.dispatchEvent(CairnEvents.openCard(cairnRef.id)), 50);
    }
  }

  return (
    <button
      onClick={handleClick}
      className={cn(
        "flex items-center gap-2 px-2.5 py-1.5 rounded-lg w-fit text-left transition-colors group",
        "bg-[var(--surface-2)] border border-[var(--border)]",
        "hover:border-[var(--accent)]/50 hover:bg-[color-mix(in_srgb,var(--accent)_4%,var(--surface-2))]",
        !ok && "border-[var(--danger)]/30 opacity-60 pointer-events-none",
      )}
    >
      <div className={cn(
        "w-5 h-5 rounded flex items-center justify-center flex-shrink-0",
        isNote
          ? "bg-[color-mix(in_srgb,var(--accent)_12%,transparent)]"
          : "bg-[color-mix(in_srgb,var(--success,#22c55e)_12%,transparent)]",
      )}>
        {isNote
          ? <FileText size={10} className="text-[var(--accent)]" />
          : <SquareCheck size={10} className="text-[color-mix(in_srgb,var(--success,#22c55e)_90%,var(--text-primary))]" />
        }
      </div>

      <div className="flex flex-col min-w-0">
        <span className="text-[0.643rem] text-[var(--text-tertiary)] leading-none mb-0.5">{actionLabel}</span>
        <span className="text-[0.714rem] font-medium text-[var(--text-primary)] truncate max-w-[200px] leading-none group-hover:text-[var(--accent)] transition-colors">
          {cairnRef.title}
        </span>
      </div>

      <CheckCircle size={9} className={cn("shrink-0 ml-auto", ok ? "text-[var(--accent)]" : "text-[var(--danger)]")} />
    </button>
  );
}
