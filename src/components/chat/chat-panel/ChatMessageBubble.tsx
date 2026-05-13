"use client";

import React, { useState } from "react";
import { Bot, User, FileText, Kanban, FolderOpen, Search, Copy, Check, RotateCcw, CheckCircle } from "lucide-react";
import { cn, formatRelative } from "@/lib/utils";
import { MarkdownContent } from "./MarkdownContent";
import type { ChatMessage, LinkedContextReference } from "@/types";
import { CairnEvents } from "@/lib/events";
import { useCairnStore } from "@/store";

interface ChatMessageBubbleProps {
  message: ChatMessage;
  onRetry?: (content: string) => void;
}

export function ChatMessageBubble({ message, onRetry }: ChatMessageBubbleProps) {
  const isUser = message.role === "user";
  const [copied, setCopied] = useState(false);

  function handleCopy() {
    navigator.clipboard.writeText(message.content).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <div className={cn("group flex gap-2 items-start", isUser && "flex-row-reverse")}>
      <div className={cn("w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5",
        isUser ? "bg-[var(--surface-3)] border border-[var(--border)]" : "bg-[var(--accent-dim)] border border-[var(--accent)]/20")}>
        {isUser ? <User size={11} className="text-[var(--text-tertiary)]" /> : <Bot size={11} className="text-[var(--accent)]" />}
      </div>
      <div className={cn("flex-1 min-w-0 space-y-1.5", isUser && "items-end flex flex-col")}>
        {!isUser && message.toolCalls && message.toolCalls.length > 0 && (
          <div className="flex flex-col gap-1 mb-1">
            {message.toolCalls.map((tc, i) => (
              <div key={i} className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-[var(--surface-2)] border border-[var(--border)] w-fit">
                <CheckCircle size={10} className="text-[var(--accent)] shrink-0" />
                <span className="text-[0.786rem] text-[var(--text-secondary)]">{tc.label}</span>
              </div>
            ))}
          </div>
        )}
        <div className={cn("px-3 py-2.5 rounded-xl text-xs leading-relaxed max-w-full",
          isUser ? "bg-[var(--accent)] text-white rounded-tr-sm" : "bg-[var(--surface-2)] border border-[var(--border)] text-[var(--text-secondary)] rounded-tl-sm")}>
          <MarkdownContent content={message.content} />
        </div>
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
}

function ContextRefChip({ ref_ }: { ref_: LinkedContextReference }) {
  const setView = useCairnStore((s) => s.setView);
  const icons = { note: <FileText size={12} />, task: <Kanban size={12} />, project: <FolderOpen size={12} />, search_result: <Search size={12} /> };

  function handleClick() {
    if (ref_.type === "task") {
      setView("board");
      setTimeout(() => window.dispatchEvent(CairnEvents.openCard(ref_.id)), 50);
    } else if (ref_.type === "note") {
      setView("notes");
      setTimeout(() => window.dispatchEvent(CairnEvents.selectNote(ref_.id)), 50);
    }
  }

  if (ref_.type === "task") {
    return (
      <button
        onClick={handleClick}
        className="w-full text-left p-3 mt-1 rounded-xl border border-[var(--border)] bg-[var(--surface)] hover:bg-[var(--surface-2)] transition-colors group cursor-pointer"
      >
        <div className="flex items-center gap-2 mb-1.5">
          <div className="p-1 rounded-md bg-[var(--surface-3)] text-[var(--text-tertiary)]">
            {icons.task}
          </div>
          <span className="text-[0.786rem] font-medium text-[var(--text-primary)] group-hover:text-[var(--accent)] transition-colors truncate">
            {ref_.title}
          </span>
        </div>
        {ref_.snippet && (
          <div className="text-[0.714rem] text-[var(--text-tertiary)] line-clamp-2 leading-relaxed ml-7">
            {ref_.snippet}
          </div>
        )}
      </button>
    );
  }

  if (ref_.type === "note") {
    return (
      <button
        onClick={handleClick}
        className="flex items-center gap-1.5 px-2.5 py-1.5 mt-1 rounded-lg border border-[var(--border)] bg-[var(--surface)] hover:bg-[var(--surface-2)] transition-colors group cursor-pointer max-w-full"
      >
        <div className="text-[var(--info)] flex-shrink-0">
          {icons.note}
        </div>
        <span className="text-[0.786rem] text-[var(--text-secondary)] group-hover:text-[var(--info)] transition-colors truncate">
          {ref_.title}
        </span>
      </button>
    );
  }

  return (
    <span className="flex items-center gap-1 px-1.5 py-0.5 mt-1 rounded bg-[var(--surface-3)] border border-[var(--border)] text-[0.714rem] text-[var(--text-tertiary)]">
      {icons[ref_.type]}{ref_.title}
    </span>
  );
}
