"use client";

import React from "react";
import { Check, Copy, FileText, FolderOpen, Info, Kanban, RotateCcw, Search } from "lucide-react";
import { useCopyToClipboard } from "@/hooks/useCopyToClipboard";
import { cn } from "@/lib/utils";
import { MarkdownContent } from "@/components/conversation/MarkdownContent";
import { ThinkingPanel } from "@/components/conversation/ThinkingPanel";
import { MessageFeedbackControl } from "@/components/conversation/MessageFeedbackControl";
import { MessageAvatar, StreamingCursor } from "@/components/conversation/message-ui";
import type { LinkedContextReference } from "@/types";
import { toConversationSubagent } from "./conversation-message";
import type { ConversationMessage } from "./conversation-message";
import { ConversationToolCall } from "./ConversationToolCall";
import { ConversationSubagentBlock } from "./ConversationSubagentBlock";
import { messageStatsSegments } from "../../../shared/chat/message-stats";
import type { ConnectorMeta } from "@/components/shared/ConnectorToolCard";

interface ConversationMessageBubbleProps {
  message: ConversationMessage;
  sessionId?: string;
  onRetry?: (content: string) => void;
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
  connectors,
}: ConversationMessageBubbleProps) {
  const isUser = message.role === "user";
  const isSystem = message.role === "system";
  const isError = message.role === "error";
  const { copied, copy } = useCopyToClipboard();
  const [statsOpen, setStatsOpen] = React.useState(false);
  // Whitespace-only content still renders as a blank bubble, so treat it as
  // empty. Defensive `?? ""`: persisted transcripts predate the required type.
  const hasContent = (message.content ?? "").trim().length > 0;
  const hasReasoning = Boolean(message.reasoning || message.reasoningSummary);
  const hasToolCalls = (message.toolCalls?.length ?? 0) > 0;
  const hasSubagents = (message.subagents?.length ?? 0) > 0;

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
        {!isUser && message.subagents && message.subagents.length > 0 && (
          <div className="flex flex-col gap-1 mb-1">
            {message.subagents.map((subagent, index) => <ConversationSubagentBlock key={index} subagent={toConversationSubagent(subagent as never)} sessionId={_sessionId} connectors={connectors} />)}
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
        {/* The content bubble is padding + background, so rendering it with an
            empty `content` produces a blank second "message". That happens on
            every reasoning-only or tool-only step, where the model streams
            thinking (or calls a tool) before writing any text.

            Chat never showed this because its live turn is drawn by
            ToolCallIndicator, which has always guarded on `hasContent`; Coding
            streams through real AgentMessages and so hit the unguarded shared
            bubble — hence "a thinking block and an empty message below" on the
            coding agent only.

            The streaming fallback keeps a visible cursor when there is nothing
            else on screen yet (the equivalent of Chat's "Thinking…" chip), so a
            live turn is never rendered as completely empty. */}
        {(hasContent || (message.isStreaming && !hasReasoning && !hasToolCalls && !hasSubagents)) && (
          <div className={cn("px-3 py-2.5 rounded-xl text-xs leading-relaxed max-w-full", isUser ? "chat-bubble-user rounded-tr-sm" : "chat-bubble-ai rounded-tl-sm")}>
            {hasContent && <MarkdownContent content={message.content} isUser={isUser} />}
            {!isUser && message.isStreaming && <StreamingCursor size="md" />}
          </div>
        )}
        {/* Per-turn throughput/latency — behind a small info button on settled
            assistant messages, shown only when derivable (no zero/NaN lines). */}
        {!isUser && !message.isStreaming && (() => {
          const segments = messageStatsSegments(message.stats);
          if (!segments.length) return null;
          return (
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => setStatsOpen((v) => !v)}
                aria-label="Message speed & token stats"
                aria-expanded={statsOpen}
                title={statsOpen ? "Hide stats" : "Message stats"}
                className={cn(
                  "flex items-center justify-center w-4 h-4 rounded-full border transition-colors flex-shrink-0",
                  statsOpen
                    ? "border-[var(--accent)] text-[var(--accent)] bg-[var(--accent-dim)]"
                    : "border-[var(--border)] text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] hover:bg-[var(--surface-3)]",
                )}
              >
                <Info size={9} />
              </button>
              {statsOpen && (
                <div className="flex items-center gap-1.5 text-[0.607rem] text-[var(--text-tertiary)] font-mono tabular-nums">
                  {segments.map((seg, i) => (
                    <React.Fragment key={seg}>
                      {i > 0 && <span className="opacity-50">·</span>}
                      <span>{seg}</span>
                    </React.Fragment>
                  ))}
                </div>
              )}
            </div>
          );
        })()}
        {message.extraContent}
        {message.contextRefs && message.contextRefs.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {message.contextRefs.map((ref, index) => <ContextRefChip key={`${ref.id ?? ref.title ?? ""}-${index}`} ref_={ref} />)}
          </div>
        )}
        {/* Copy/Retry both act on `content`, so they are pointless on a
            reasoning-only or tool-only message — and the empty flex row still
            reserved layout under the thinking panel. */}
        {hasContent && (
          <div className={cn("flex items-center gap-1.5", isUser ? "flex-row-reverse" : "")}>
            <div className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 flex items-center gap-0.5 transition-opacity">
              <button onClick={() => copy(message.content)} title="Copy" className="p-0.5 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-3)] transition-colors">
                {copied ? <Check size={10} className="text-[var(--success)]" /> : <Copy size={10} />}
              </button>
              {isUser && onRetry && <button onClick={() => onRetry(message.content)} title="Retry" className="p-0.5 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-3)] transition-colors"><RotateCcw size={10} /></button>}
            </div>
            {/* Thumbs rating lives outside the hover-only wrapper so an active
                rating stays visible; the control hides itself for user bubbles
                (isUser), streaming turns, and non-ratable messages. */}
            {!isUser && !message.isStreaming && (
              <MessageFeedbackControl sessionId={_sessionId} messageId={message.id} />
            )}
          </div>
        )}
      </div>
    </div>
  );
}, (previous, next) => previous.message === next.message && previous.sessionId === next.sessionId && previous.onRetry === next.onRetry);
