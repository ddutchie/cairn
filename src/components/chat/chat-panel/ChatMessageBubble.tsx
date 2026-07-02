"use client";

import React from "react";
import { useCopyToClipboard } from "@/hooks/useCopyToClipboard";
import { FileText, Kanban, FolderOpen, Search, Copy, Check, RotateCcw, CheckCircle } from "lucide-react";
import { cn, formatRelative, prettifyToolLabel } from "@/lib/utils";
import { MarkdownContent } from "./MarkdownContent";
import { ActionsList } from "./ActionsList";
import { ThinkingPanel } from "./ThinkingPanel";
import { MessageAvatar } from "./message-ui";
import { CairnRefChip } from "@/components/shared/cairn-ref-chip";
import type { ChatMessage, LinkedContextReference, ChatToolCallRecord } from "@/types";

function ChatToolCallChip({ tc }: { tc: ChatToolCallRecord }) {
  if (!tc.cairnRef) {
    return (
      <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-[var(--surface-2)] border border-[var(--border)] w-fit">
        <CheckCircle size={10} className="text-[var(--accent)] shrink-0" />
        <span className="text-[0.786rem] text-[var(--text-secondary)]">{prettifyToolLabel(tc.label)}</span>
      </div>
    );
  }

  return <CairnRefChip toolName={tc.tool} cairnRef={tc.cairnRef} />;
}

interface ChatMessageBubbleProps {
  message: ChatMessage;
  onRetry?: (content: string) => void;
}

export const ChatMessageBubble = React.memo(function ChatMessageBubble({ message, onRetry }: ChatMessageBubbleProps) {
  const isUser = message.role === "user";
  const isSystem = message.role === "system";
  const { copied, copy } = useCopyToClipboard();

  function handleCopy() {
    copy(message.content);
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
        {!isUser && message.reasoning && (
          <ThinkingPanel text={message.reasoning} />
        )}
        {message.images && message.images.length > 0 && (
          <div className={cn("flex flex-wrap gap-2", isUser && "justify-end")}>
            {message.images.map((img, i) => (
              <img
                key={i}
                src={img.url}
                alt={img.name}
                className="max-w-[200px] max-h-[200px] rounded-lg border border-[var(--border)] object-cover"
              />
            ))}
          </div>
        )}
        <div className={cn("px-3 py-2.5 rounded-xl text-xs leading-relaxed max-w-full",
          isUser ? "bg-[var(--accent)] text-[var(--accent-fg)] rounded-tr-sm" : "bg-[var(--surface-2)] border border-[var(--border)] text-[var(--text-secondary)] rounded-tl-sm")}>
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
