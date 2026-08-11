"use client";

import React from "react";
import { useCopyToClipboard } from "@/hooks/useCopyToClipboard";
import { FileText, Kanban, FolderOpen, Search, Copy, Check, RotateCcw, CheckCircle, XCircle } from "lucide-react";
import { cn, formatRelative } from "@/lib/utils";
import { MarkdownContent } from "./MarkdownContent";
import { ActionsList } from "./ActionsList";
import { ThinkingPanel } from "./ThinkingPanel";
import { ChatSubagentBlock } from "./ChatSubagentBlock";
import { MessageAvatar } from "./message-ui";
import { CairnRefChip, ExternalRefChip } from "@/components/shared/cairn-ref-chip";
import { WritingStylePromptChip, writingStyleNeedsSetup } from "@/components/shared/WritingStylePromptChip";
import { ConnectorToolCard } from "@/components/shared/ConnectorToolCard";
import type { ChatMessage, LinkedContextReference, ChatToolCallRecord } from "@/types";
import { humanizeTool } from "@/lib/humanize-tool";
import { connectorForTool, parseToolArgs, type ChatConnectorMeta } from "./connector-context";

function ChatToolCallChip({ tc, connectors }: { tc: ChatToolCallRecord; connectors?: Record<string, ChatConnectorMeta> }) {
  // A failed tool never produced a usable ref — show the failure reason.
  if (tc.ok === false) {
    return (
      <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-[color-mix(in_srgb,var(--danger)_8%,transparent)] border border-[color-mix(in_srgb,var(--danger)_30%,transparent)] w-fit max-w-full" title={tc.error}>
        <XCircle size={10} className="text-[var(--danger)] shrink-0" />
        <span className="text-[0.786rem] text-[var(--text-secondary)]">{humanizeTool(tc.tool, parseToolArgs(tc.args)).pre} failed</span>
        {tc.error && <span className="text-[0.714rem] text-[var(--text-tertiary)] truncate max-w-[220px]">— {tc.error}</span>}
      </div>
    );
  }
  if (tc.cairnRef) {
    return <CairnRefChip toolName={tc.tool} cairnRef={tc.cairnRef} />;
  }
  // Writing style not configured — surface the "set up" prompt (persisted
  // messages render here, not ToolCallIndicator, so this is where it shows
  // after the stream completes).
  if (tc.tool === "get_user_writing_style" && writingStyleNeedsSetup(tc.output)) {
    return <WritingStylePromptChip output={tc.output} />;
  }
  const connector = connectors ? connectorForTool(tc.tool, connectors) : undefined;
  if (connector) return <ConnectorToolCard toolCall={{ tool: tc.tool, args: parseToolArgs(tc.args), output: tc.output, externalRef: tc.externalRef }} connector={connector} testId="chat-connector-card" />;
  if (tc.externalRef) {
    return <ExternalRefChip toolName={tc.tool} externalRef={tc.externalRef} />;
  }
  return (
    <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-[var(--surface-2)] border border-[var(--border)] w-fit">
      <CheckCircle size={10} className="text-[var(--accent)] shrink-0" />
       {(() => { const summary = humanizeTool(tc.tool, parseToolArgs(tc.args)); return <span className="text-[0.786rem] text-[var(--text-secondary)]">{summary.pre}{summary.obj ? <> <strong className="font-medium text-[var(--text-primary)]">{summary.obj}</strong></> : null}</span>; })()}
    </div>
  );
}

interface ChatMessageBubbleProps {
  message: ChatMessage;
  onRetry?: (content: string) => void;
  connectors?: Record<string, ChatConnectorMeta>;
}

export const ChatMessageBubble = React.memo(function ChatMessageBubble({ message, onRetry, connectors }: ChatMessageBubbleProps) {
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
        {!isUser && message.subagents && message.subagents.length > 0 && (
          <div className="flex flex-col gap-1 mb-1">
            {message.subagents.map((sub) => (
              <ChatSubagentBlock key={sub.childId} sub={sub} />
            ))}
          </div>
        )}
        {!isUser && message.toolCalls && message.toolCalls.length > 0 && (
          <div className="flex flex-col gap-1 mb-1">
            {message.toolCalls.map((tc, i) => (
              <ChatToolCallChip key={i} tc={tc} connectors={connectors} />
            ))}
          </div>
        )}
        {!isUser && message.reasoning && (
          <ThinkingPanel text={message.reasoning} />
        )}
        {message.images && message.images.length > 0 && (
          <div className={cn("flex flex-wrap gap-2", isUser && "justify-end")}>
            {message.images.map((img, i) =>
              img.kind === "pdf" ? (
                <div
                  key={i}
                  className="max-w-[200px] rounded-lg border border-[var(--border)] bg-[var(--surface-2)] flex items-center gap-2 px-3 py-2"
                  title={img.name}
                >
                  <FileText size={14} className="text-[var(--danger)] shrink-0" />
                  <span className="text-[0.714rem] text-[var(--text-secondary)] truncate">{img.name}</span>
                </div>
              ) : (
                <img
                  key={i}
                  src={img.url}
                  alt={img.name}
                  className="max-w-[200px] max-h-[200px] rounded-lg border border-[var(--border)] object-cover"
                />
              )
            )}
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
              {copied ? <Check size={10} className="text-[var(--success)]" /> : <Copy size={10} />}
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
