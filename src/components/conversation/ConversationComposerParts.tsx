"use client";

import { ChevronDown, Clock, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

export interface ConversationQueuedItem {
  id: string;
  content: string;
  attachments?: unknown[];
}

interface ConversationWorkingStatusProps {
  label: string;
}

/** Shared busy strip shown above a conversation composer. */
export function ConversationWorkingStatus({ label }: ConversationWorkingStatusProps) {
  return (
    <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-[var(--border)] bg-[var(--surface)]">
      <Loader2 size={11} className="text-[var(--accent)] animate-spin shrink-0" />
      <span className="text-[0.714rem] text-[var(--text-secondary)]">{label}</span>
    </div>
  );
}

interface ConversationQueueDockProps {
  items: ConversationQueuedItem[];
  expanded: boolean;
  onToggle: () => void;
  onRemove: (id: string) => void;
  noun: string;
}

/** Shared queued-message disclosure used by Chat and Coding composers. */
export function ConversationQueueDock({ items, expanded, onToggle, onRemove, noun }: ConversationQueueDockProps) {
  if (items.length === 0) return null;
  return (
    <div className="border-b border-[var(--border)] bg-[var(--surface)]">
      <button type="button" onClick={onToggle} className="w-full flex items-center gap-1.5 px-3 py-1.5 text-left hover:bg-[var(--surface-2)] transition-colors">
        <Clock size={11} className="text-[var(--text-tertiary)] shrink-0" />
        <span className="text-[0.714rem] text-[var(--text-secondary)]">
          {items.length} {noun}{items.length === 1 ? "" : "s"} queued
        </span>
        <ChevronDown size={11} className={cn("ml-auto text-[var(--text-tertiary)] shrink-0 transition-transform", expanded && "rotate-180")} />
      </button>
      {expanded && (
        <div className="px-3 pb-2 space-y-2">
          {items.map((item) => (
            <div key={item.id} className="flex items-start gap-2">
              <span className="text-[0.714rem] text-[var(--text-secondary)] flex-1 min-w-0 line-clamp-2">
                {item.content || (item.attachments && item.attachments.length > 0 ? "(attachment)" : "")}
                {item.attachments && item.attachments.length > 0 && item.content
                  ? ` · ${item.attachments.length} attachment${item.attachments.length === 1 ? "" : "s"}`
                  : null}
              </span>
              <button type="button" onClick={() => onRemove(item.id)} className="text-[0.643rem] text-[var(--text-tertiary)] hover:text-[var(--danger)] shrink-0 transition-colors">
                Remove
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
