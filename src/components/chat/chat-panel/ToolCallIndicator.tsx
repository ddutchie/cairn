"use client";

import React from "react";
import { Loader2, CheckCircle, Bot } from "lucide-react";
import { MarkdownContent } from "./MarkdownContent";
import type { ChatToolCall } from "@/hooks/useChatStream";

interface ToolCallIndicatorProps {
  toolCalls: ChatToolCall[];
  streamingContent: string;
}

export function ToolCallIndicator({ toolCalls, streamingContent }: ToolCallIndicatorProps) {
  return (
    <div className="flex gap-2 items-start">
      <div className="w-6 h-6 rounded-full bg-[var(--accent-dim)] border border-[var(--accent)]/20 flex items-center justify-center flex-shrink-0 mt-0.5 shrink-0">
        <Bot size={11} className="text-[var(--accent)]" />
      </div>
      <div className="flex flex-col gap-1 min-w-0 flex-1">
        {toolCalls.map((tc, i) => (
          <div key={i} className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-[var(--surface-2)] border border-[var(--border)] w-fit">
            <CheckCircle size={10} className="text-[var(--accent)] shrink-0" />
            <span className="text-[11px] text-[var(--text-secondary)]">{tc.label}</span>
          </div>
        ))}
        {streamingContent ? (
          <div className="px-3 py-2.5 rounded-xl rounded-tl-sm text-xs leading-relaxed bg-[var(--surface-2)] border border-[var(--border)] text-[var(--text-secondary)] max-w-full">
            <MarkdownContent content={streamingContent} />
            <span className="inline-block w-0.5 h-3 bg-[var(--accent)] animate-pulse ml-0.5 align-middle" />
          </div>
        ) : (
          <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-[var(--surface-2)] border border-[var(--border)] w-fit">
            <Loader2 size={10} className="text-[var(--accent)] animate-spin shrink-0" />
            <span className="text-[11px] text-[var(--text-tertiary)]">
              {toolCalls.length === 0 ? "Thinking…" : "Working…"}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
