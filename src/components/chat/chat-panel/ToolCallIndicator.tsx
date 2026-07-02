"use client";

import React from "react";
import { Loader2, CheckCircle } from "lucide-react";
import { MarkdownContent } from "./MarkdownContent";
import { ThinkingPanel } from "./ThinkingPanel";
import { MessageAvatar, StreamingCursor } from "./message-ui";
import { prettifyToolLabel } from "@/lib/utils";
import type { ChatToolCall } from "@/hooks/useChatStream";

interface ToolCallIndicatorProps {
  toolCalls: ChatToolCall[];
  streamingContent: string;
  streamingThought?: string;
}

export const ToolCallIndicator = React.memo(function ToolCallIndicator({ toolCalls, streamingContent, streamingThought }: ToolCallIndicatorProps) {
  const hasThought = !!streamingThought;
  const hasContent = !!streamingContent;
  return (
    <div className="flex gap-2 items-start">
      <MessageAvatar role="bot" size="lg" />
      <div className="flex flex-col gap-1 min-w-0 flex-1">
        {toolCalls.map((tc, i) => (
          <div key={i} className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-[var(--surface-2)] border border-[var(--border)] w-fit">
            {tc.status === "running" ? (
              <Loader2 size={10} className="text-[var(--accent)] animate-spin shrink-0" />
            ) : (
              <CheckCircle size={10} className="text-[var(--accent)] shrink-0" />
            )}
            <span className="text-[0.786rem] text-[var(--text-secondary)]">{prettifyToolLabel(tc.label)}</span>
          </div>
        ))}
        {hasThought && (
          <div className="max-w-full w-fit">
            <ThinkingPanel
              text={streamingThought ?? ""}
              streaming
              companionContent={streamingContent}
            />
          </div>
        )}
        {hasContent ? (
          <div className="px-3 py-2.5 rounded-xl rounded-tl-sm text-xs leading-relaxed bg-[var(--surface-2)] border border-[var(--border)] text-[var(--text-secondary)] max-w-full">
            <MarkdownContent content={streamingContent} />
            <StreamingCursor />
          </div>
        ) : !hasThought ? (
          <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-[var(--surface-2)] border border-[var(--border)] w-fit">
            <Loader2 size={10} className="text-[var(--accent)] animate-spin shrink-0" />
            <span className="text-[0.786rem] text-[var(--text-tertiary)]">
              {toolCalls.length === 0 ? "Thinking…" : "Working…"}
            </span>
          </div>
        ) : null}
      </div>
    </div>
  );
});
