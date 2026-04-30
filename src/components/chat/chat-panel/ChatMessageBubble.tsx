"use client";

import React from "react";
import { Bot, User, FileText, Kanban, FolderOpen } from "lucide-react";
import { cn, formatRelative } from "@/lib/utils";
import { MarkdownContent } from "./MarkdownContent";
import type { ChatMessage, LinkedContextReference } from "@/types";

export function ChatMessageBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === "user";
  return (
    <div className={cn("flex gap-2 items-start", isUser && "flex-row-reverse")}>
      <div className={cn("w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5",
        isUser ? "bg-[var(--surface-3)] border border-[var(--border)]" : "bg-[var(--accent-dim)] border border-[var(--accent)]/20")}>
        {isUser ? <User size={11} className="text-[var(--text-tertiary)]" /> : <Bot size={11} className="text-[var(--accent)]" />}
      </div>
      <div className={cn("flex-1 min-w-0 space-y-1.5", isUser && "items-end flex flex-col")}>
        <div className={cn("px-3 py-2.5 rounded-xl text-xs leading-relaxed max-w-full",
          isUser ? "bg-[var(--accent)] text-white rounded-tr-sm" : "bg-[var(--surface-2)] border border-[var(--border)] text-[var(--text-secondary)] rounded-tl-sm")}>
          {isUser ? <span className="whitespace-pre-wrap">{message.content}</span> : <MarkdownContent content={message.content} />}
        </div>
        {message.contextRefs && message.contextRefs.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {message.contextRefs.map((ref, i) => <ContextRefChip key={i} ref_={ref} />)}
          </div>
        )}
        <span className="text-[10px] text-[var(--text-tertiary)]">{formatRelative(message.createdAt)}</span>
      </div>
    </div>
  );
}

function ContextRefChip({ ref_ }: { ref_: LinkedContextReference }) {
  const icons = { note: <FileText size={9} />, task: <Kanban size={9} />, project: <FolderOpen size={9} />, search_result: <Kanban size={9} /> };
  return (
    <span className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-[var(--surface-3)] border border-[var(--border)] text-[10px] text-[var(--text-tertiary)]">
      {icons[ref_.type]}{ref_.title}
    </span>
  );
}
