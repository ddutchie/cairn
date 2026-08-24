"use client";

import React from "react";
import { Check, Copy, FileText, FolderOpen, Kanban, RotateCcw, Search } from "lucide-react";
import { useCopyToClipboard } from "@/hooks/useCopyToClipboard";
import { cn, formatRelative } from "@/lib/utils";
import { MarkdownContent } from "@/components/chat/chat-panel/MarkdownContent";
import { ThinkingPanel } from "@/components/chat/chat-panel/ThinkingPanel";
import { MessageAvatar, StreamingCursor } from "@/components/chat/chat-panel/message-ui";
import type { LinkedContextReference } from "@/types";
import type { ConversationMessage } from "./conversation-message";
import { ConversationToolCall } from "./ConversationToolCall";
import type { ConnectorMeta } from "@/components/shared/ConnectorToolCard";

interface ConversationMessageBubbleProps {
  message: ConversationMessage;
  sessionId?: string;
  onRetry?: (content: string) => void;
  renderSubagent?: (subagent: unknown, index: number) => React.ReactNode;
  connectors?: Record<string, ConnectorMeta>;
}

function ContextRefChip({ ref_ }: { ref_: LinkedContextReference }) {
  const icons = { note: <FileText size={9} />, task: <Kanban size={9} />, project: <FolderOpen size={9} />, search_result: <Search size={9} /> };
  return (
    <span className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-[var(--surface-3)] border border-[var(--border)] text-[0.714rem] text-[var(--text-tertiary)]">
      {icons[ref_.type]}{ref_.title}
    </span>
  );
}

export const ConversationMessageBubble = React.memo(function ConversationMessageBubble({
  message,
  sessionId: _sessionId,
  onRetry,
  renderSubagent,
  connectors,
}: ConversationMessageBubbleProps) {
  const isUser = message.role === "user";
  const isSystem = message.role === "system";
  const isError = message.role === "error";
  const { copied, copy } = useCopyToClipboard();

  if (isSystem) {
    return (
      <div className="flex justify-center py-0.5">
        <span className="text-[0.643rem] italic text-[var(--text-tertiary)] px-2">{message.content}</span>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex gap-2 items-start">
        <MessageAvatar role="error" size="md" />
        <div className="flex-1 min-w-0">
          <div className="px-3 py-2 rounded-xl rounded-tl-sm text-xs leading-relaxed bg-[color-mix(in_srgb,var(--danger)_8%,transparent)] border border-[var(--danger)]/20 text-[var(--danger)]">
            {message.content}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={cn("group flex gap-2 items-start", isUser && "flex-row-reverse")}>
      <MessageAvatar role={isUser ? "user" : "bot"} size={isUser ? "lg" : "md"} />
      <div className={cn("flex-1 min-w-0 space-y-1.5", isUser && "items-end flex flex-col")}>
        {!isUser && message.subagents && message.subagents.length > 0 && renderSubagent && (
          <div className="flex flex-col gap-1 mb-1">
            {message.subagents.map((subagent, index) => renderSubagent(subagent, index))}
          </div>
        )}
        {!isUser && message.toolCalls && message.toolCalls.length > 0 && (
          <div className="flex flex-col gap-1 mb-1">
            {message.toolCalls.map((toolCall, index) => <ConversationToolCall key={toolCall.callId ?? `${toolCall.name}-${index}`} toolCall={toolCall} sessionId={_sessionId} connectors={connectors} />)}
          </div>
        )}
        {!isUser && (message.reasoning || message.reasoningSummary) && (
          <ThinkingPanel text={message.reasoning ?? ""} summary={message.reasoningSummary} streaming={message.isStreaming} companionContent={message.content} />
        )}
        {message.images && message.images.length > 0 && (
          <div className={cn("flex flex-wrap gap-2", isUser && "justify-end")}>
            {message.images.map((image, index) => image.kind === "pdf" ? (
              <div key={`${image.name}-${index}`} className="max-w-[200px] rounded-lg border border-[var(--border)] bg-[var(--surface-2)] flex items-center gap-2 px-3 py-2" title={image.name}>
                <FileText size={14} className="text-[var(--danger)] shrink-0" />
                <span className="text-[0.714rem] text-[var(--text-secondary)] truncate">{image.name}</span>
              </div>
            ) : (
              <img key={`${image.name}-${index}`} src={image.url} alt={image.name} className="max-w-[200px] max-h-[200px] rounded-lg border border-[var(--border)] object-cover" />
            ))}
          </div>
        )}
        <div className={cn("px-3 py-2.5 rounded-xl text-xs leading-relaxed max-w-full", isUser ? "chat-bubble-user rounded-tr-sm" : "chat-bubble-ai rounded-tl-sm")}>
          <MarkdownContent content={message.content} isUser={isUser} />
          {!isUser && message.isStreaming && <StreamingCursor size="md" />}
        </div>
        {message.extraContent}
        {message.contextRefs && message.contextRefs.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {message.contextRefs.map((ref, index) => <ContextRefChip key={`${ref.id ?? ref.title ?? ""}-${index}`} ref_={ref} />)}
          </div>
        )}
        <div className={cn("flex items-center gap-1.5", isUser ? "flex-row-reverse" : "")}>
          <span className="text-[0.714rem] text-[var(--text-tertiary)]">{formatRelative(message.createdAt)}</span>
          <div className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 flex items-center gap-0.5 transition-opacity">
            <button onClick={() => copy(message.content)} title="Copy" className="p-0.5 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-3)] transition-colors">
              {copied ? <Check size={10} className="text-[var(--success)]" /> : <Copy size={10} />}
            </button>
            {isUser && onRetry && <button onClick={() => onRetry(message.content)} title="Retry" className="p-0.5 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-3)] transition-colors"><RotateCcw size={10} /></button>}
          </div>
        </div>
      </div>
    </div>
  );
}, (previous, next) => previous.message === next.message && previous.sessionId === next.sessionId && previous.onRetry === next.onRetry);
