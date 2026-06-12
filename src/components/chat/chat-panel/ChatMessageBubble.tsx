"use client";

import React, { useState } from "react";
import { FileText, Kanban, FolderOpen, Search, Copy, Check, RotateCcw, CheckCircle, SquareCheck } from "lucide-react";
import { cn, formatRelative } from "@/lib/utils";
import { useCairnStore } from "@/store";
import { CairnEvents } from "@/lib/events";
import { MarkdownContent } from "./MarkdownContent";
import { ActionsList } from "./ActionsList";
import { MessageAvatar } from "./message-ui";
import type { ChatMessage, LinkedContextReference, ChatToolCallRecord } from "@/types";

const CAIRN_NOTE_ACTIONS: Record<string, string> = {
  create_note:     "Created note",
  ensure_note:     "Saved note",
  update_note:     "Updated note",
  patch_note:      "Patched note",
  append_to_note:  "Appended to note",
  get_note:        "Read note",
};

const CAIRN_TASK_ACTIONS: Record<string, string> = {
  create_task:        "Created task",
  update_task:        "Updated task",
  update_task_status: "Moved task",
  get_task:           "Read task",
};

function ChatToolCallChip({ tc }: { tc: ChatToolCallRecord }) {
  const setView = useCairnStore((s) => s.setView);

  if (!tc.cairnRef) {
    return (
      <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-[var(--surface-2)] border border-[var(--border)] w-fit">
        <CheckCircle size={10} className="text-[var(--accent)] shrink-0" />
        <span className="text-[0.786rem] text-[var(--text-secondary)]">{tc.label}</span>
      </div>
    );
  }

  const isNote = tc.cairnRef.type === "note";
  const actionLabel = isNote
    ? (CAIRN_NOTE_ACTIONS[tc.tool] ?? "Updated note")
    : (CAIRN_TASK_ACTIONS[tc.tool] ?? "Updated task");

  function handleClick() {
    if (isNote) {
      setView("notes");
      setTimeout(() => window.dispatchEvent(CairnEvents.selectNote(tc.cairnRef!.id)), 50);
    } else {
      setView("board");
      setTimeout(() => window.dispatchEvent(CairnEvents.openCard(tc.cairnRef!.id)), 50);
    }
  }

  return (
    <button
      onClick={handleClick}
      className={cn(
        "flex items-center gap-2 px-2.5 py-1.5 rounded-lg w-fit text-left transition-colors group",
        "bg-[var(--surface-2)] border border-[var(--border)]",
        "hover:border-[var(--accent)]/50 hover:bg-[color-mix(in_srgb,var(--accent)_4%,var(--surface-2))]",
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
          {tc.cairnRef.title}
        </span>
      </div>

      <CheckCircle size={9} className="shrink-0 ml-auto text-[var(--accent)]" />
    </button>
  );
}

interface ChatMessageBubbleProps {
  message: ChatMessage;
  onRetry?: (content: string) => void;
}

export const ChatMessageBubble = React.memo(function ChatMessageBubble({ message, onRetry }: ChatMessageBubbleProps) {
  const isUser = message.role === "user";
  const isSystem = message.role === "system";
  const [copied, setCopied] = useState(false);

  function handleCopy() {
    navigator.clipboard.writeText(message.content).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  if (isSystem) {
    const isMarkdown = message.content.includes("\n") || message.content.includes("#");
    if (isMarkdown) {
      return (
        <div className="flex justify-center py-1.5 w-full">
          <div className="text-[0.786rem] text-[var(--text-secondary)] bg-[var(--surface-2)] border border-[var(--border)] rounded-xl px-4 py-3 max-w-[95%] w-full shadow-sm">
            <MarkdownContent content={message.content} />
          </div>
        </div>
      );
    }
    return (
      <div className="flex justify-center py-0.5">
        <span className="text-[0.643rem] italic text-[var(--text-tertiary)] px-2">{message.content}</span>
      </div>
    );
  }

  return (
    <div className={cn("group flex gap-2 items-start", isUser && "flex-row-reverse")}>
      <MessageAvatar role={isUser ? "user" : "bot"} size="lg" />
      <div className={cn("flex-1 min-w-0 space-y-1.5", isUser && "items-end flex flex-col")}>
        {!isUser && message.toolCalls && message.toolCalls.length > 0 && (
          <div className="flex flex-col gap-1 mb-1">
            {message.toolCalls.map((tc, i) => (
              <ChatToolCallChip key={i} tc={tc} />
            ))}
          </div>
        )}
        <div className={cn("px-3 py-2.5 rounded-xl text-xs leading-relaxed max-w-full",
          isUser ? "bg-[var(--accent)] text-white rounded-tr-sm" : "bg-[var(--surface-2)] border border-[var(--border)] text-[var(--text-secondary)] rounded-tl-sm")}>
          <MarkdownContent content={message.content} isUser={isUser} />
        </div>
        {!isUser && message.actions && message.actions.length > 0 && (
          <ActionsList actions={message.actions} />
        )}
        {message.contextRefs && message.contextRefs.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {message.contextRefs.map((ref, i) => <ContextRefChip key={i} ref_={ref} />)}
          </div>
        )}
        <div className={cn("flex items-center gap-1.5", isUser ? "flex-row-reverse" : "")}>
          <span className="text-[0.714rem] text-[var(--text-tertiary)]">{formatRelative(message.createdAt)}</span>
          <div className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 flex items-center gap-0.5 transition-opacity">
            <button
              onClick={handleCopy}
              title="Copy"
              className="p-0.5 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-3)] transition-colors"
            >
              {copied ? <Check size={10} className="text-green-400" /> : <Copy size={10} />}
            </button>
            {isUser && onRetry && (
              <button
                onClick={() => onRetry(message.content)}
                title="Retry"
                className="p-0.5 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-3)] transition-colors"
              >
                <RotateCcw size={10} />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
});

function ContextRefChip({ ref_ }: { ref_: LinkedContextReference }) {
  const icons = { note: <FileText size={9} />, task: <Kanban size={9} />, project: <FolderOpen size={9} />, search_result: <Search size={9} /> };
  return (
    <span className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-[var(--surface-3)] border border-[var(--border)] text-[0.714rem] text-[var(--text-tertiary)]">
      {icons[ref_.type]}{ref_.title}
    </span>
  );
}
