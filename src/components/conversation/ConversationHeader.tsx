"use client";

import type { ReactNode } from "react";
import { ContextRing } from "@/components/agent/ContextRing";
import type { TokenBreakdown } from "@/types";

export interface ConversationUsage {
  promptTokens: number;
  completionTokens: number;
  reasoningTokens?: number;
  breakdown?: TokenBreakdown;
  costUsd?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

interface ConversationHeaderProps {
  title: ReactNode;
  usage?: ConversationUsage;
  contextLimit: number;
  actions?: ReactNode;
}

/** Shared session header shell; Chat and Coding provide only title/actions. */
export function ConversationHeader({ title, usage, contextLimit, actions }: ConversationHeaderProps) {
  return (
    <div className="flex items-center gap-2 px-3 h-9 border-b border-[var(--border)] bg-[var(--surface-2)] flex-shrink-0">
      <span className="text-[0.714rem] text-[var(--text-tertiary)] truncate flex-1">{title}</span>
      {usage && <ContextRing {...usage} contextLimit={contextLimit} />}
      {actions}
    </div>
  );
}
