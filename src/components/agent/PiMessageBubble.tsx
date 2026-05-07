"use client";

import React from "react";
import { Bot, User, CheckCircle, Loader2, AlertCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { MarkdownContent } from "@/components/chat/chat-panel/MarkdownContent";
import type { PiAgentMessage } from "@/store/slices/terminal-sessions";

interface PiMessageBubbleProps {
  message: PiAgentMessage;
}

export function PiMessageBubble({ message }: PiMessageBubbleProps) {
  const isUser  = message.role === "user";
  const isError = message.role === "error";

  if (isUser) {
    return (
      <div className="flex gap-2 items-start justify-end">
        <div className="flex-1 min-w-0 flex flex-col items-end gap-1">
          <div className="px-3 py-2 rounded-xl rounded-tr-sm text-xs leading-relaxed bg-[var(--accent)] text-white max-w-[85%]">
            <p className="whitespace-pre-wrap break-words">{message.content}</p>
          </div>
        </div>
        <div className="w-5 h-5 rounded-full bg-[var(--surface-3)] border border-[var(--border)] flex items-center justify-center flex-shrink-0 mt-0.5">
          <User size={10} className="text-[var(--text-tertiary)]" />
        </div>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex gap-2 items-start">
        <div className="w-5 h-5 rounded-full bg-[color-mix(in_srgb,var(--danger)_15%,transparent)] border border-[var(--danger)]/30 flex items-center justify-center flex-shrink-0 mt-0.5">
          <AlertCircle size={10} className="text-[var(--danger)]" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="px-3 py-2 rounded-xl rounded-tl-sm text-xs leading-relaxed bg-[color-mix(in_srgb,var(--danger)_8%,transparent)] border border-[var(--danger)]/20 text-[var(--danger)]">
            {message.content}
          </div>
        </div>
      </div>
    );
  }

  // Assistant message
  const hasContent = message.content.length > 0;
  const hasTools   = (message.toolCalls?.length ?? 0) > 0;

  return (
    <div className="flex gap-2 items-start">
      <div className="w-5 h-5 rounded-full bg-[var(--accent-dim)] border border-[var(--accent)]/20 flex items-center justify-center flex-shrink-0 mt-0.5">
        <Bot size={10} className="text-[var(--accent)]" />
      </div>
      <div className="flex-1 min-w-0 flex flex-col gap-1">

        {/* Tool call chips */}
        {hasTools && (
          <div className="flex flex-col gap-0.5">
            {message.toolCalls!.map((tc, i) => (
              <div
                key={i}
                className="flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-[var(--surface-2)] border border-[var(--border)] w-fit"
              >
                <CheckCircle size={9} className={cn("shrink-0", tc.ok ? "text-[var(--accent)]" : "text-[var(--danger)]")} />
                <span className="text-[0.714rem] text-[var(--text-secondary)]">{tc.label}</span>
              </div>
            ))}
          </div>
        )}

        {/* Streaming "thinking" indicator when no content yet */}
        {!hasContent && message.isStreaming && !hasTools && (
          <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-[var(--surface-2)] border border-[var(--border)] w-fit">
            <Loader2 size={9} className="text-[var(--accent)] animate-spin shrink-0" />
            <span className="text-[0.714rem] text-[var(--text-tertiary)]">Thinking…</span>
          </div>
        )}

        {/* Message content */}
        {hasContent && (
          <div className={cn(
            "px-3 py-2 rounded-xl rounded-tl-sm text-xs leading-relaxed",
            "bg-[var(--surface-2)] border border-[var(--border)] text-[var(--text-secondary)]",
          )}>
            <MarkdownContent content={message.content} />
            {message.isStreaming && (
              <span className="inline-block w-0.5 h-3 bg-[var(--accent)] animate-pulse ml-0.5 align-middle" />
            )}
          </div>
        )}
      </div>
    </div>
  );
}
