"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight, GitBranch, Loader2 } from "lucide-react";
import { useCairnStore } from "@/store";
import { MarkdownContent } from "@/components/chat/chat-panel/MarkdownContent";
import { ContextRing } from "@/components/agent/ContextRing";
import { ConversationMessageBubble } from "./ConversationMessageBubble";
import { ConversationToolCall } from "./ConversationToolCall";
import type { ConnectorMeta } from "@/components/shared/ConnectorToolCard";
import type { ConversationSubagent } from "./conversation-message";

interface ConversationSubagentBlockProps {
  subagent: ConversationSubagent;
  sessionId?: string;
  connectors?: Record<string, ConnectorMeta>;
}

/** Shared expandable subagent trace for Chat and Coding sessions. */
export function ConversationSubagentBlock({ subagent, sessionId, connectors }: ConversationSubagentBlockProps) {
  const [expanded, setExpanded] = useState(false);
  const contextLimit = useCairnStore((state) => state.aiConfig.contextLimit ?? 128000);
  const label = subagent.running ? `${subagent.label} working…` : subagent.label;

  return (
    <div className="mt-1 rounded-lg border border-[var(--border)] bg-[var(--surface)] overflow-hidden">
      <button type="button" onClick={() => setExpanded((value) => !value)} className="w-full flex items-center gap-1.5 px-2.5 py-1.5 hover:bg-[var(--surface-2)] transition-colors text-left">
        {subagent.running ? <Loader2 size={10} className="text-[var(--accent)] animate-spin shrink-0" /> : <GitBranch size={10} className="text-[var(--accent)] shrink-0" />}
        <span className="text-[0.786rem] font-medium text-[var(--text-secondary)] flex-1">{label}</span>
        {(subagent.toolCalls?.length ?? 0) > 0 && <span className="text-[0.643rem] text-[var(--text-tertiary)]">{subagent.toolCalls!.length} tools</span>}
        {subagent.lastUsage && <ContextRing promptTokens={subagent.lastUsage.promptTokens} contextLimit={contextLimit} breakdown={subagent.lastUsage.breakdown} completionTokens={subagent.lastUsage.completionTokens} reasoningTokens={subagent.lastUsage.reasoningTokens} cacheReadTokens={subagent.lastUsage.cacheReadTokens} cacheCreationTokens={subagent.lastUsage.cacheCreationTokens} costUsd={subagent.lastUsage.costUsd} showBalance={false} size={12} stroke={1.5} />}
        {expanded ? <ChevronDown size={10} className="text-[var(--text-tertiary)]" /> : <ChevronRight size={10} className="text-[var(--text-tertiary)]" />}
      </button>
      {expanded && (
        <div className="border-t border-[var(--border)] px-2.5 py-2 space-y-2 max-h-96 overflow-y-auto">
          {subagent.instruction && <div><p className="text-[0.643rem] uppercase tracking-wide text-[var(--text-tertiary)] mb-0.5">Instruction</p><p className="text-[0.714rem] text-[var(--text-secondary)] whitespace-pre-wrap">{subagent.instruction}</p></div>}
          {subagent.toolCalls?.map((toolCall, index) => <ConversationToolCall key={toolCall.callId ?? `${toolCall.name}-${index}`} toolCall={toolCall} sessionId={sessionId} connectors={connectors} />)}
          {subagent.messages?.map((message, index) => <ConversationMessageBubble key={message.id || index} message={message} sessionId={sessionId} connectors={connectors} />)}
          {subagent.content && <div><p className="text-[0.643rem] uppercase tracking-wide text-[var(--text-tertiary)] mb-0.5">Brief</p><div className="px-2 py-1 rounded-md bg-[var(--surface-2)] border border-[var(--border)] text-[0.714rem] text-[var(--text-secondary)]"><MarkdownContent content={subagent.content} /></div></div>}
          {!subagent.content && !subagent.messages?.length && subagent.running && <div className="flex items-center gap-1 px-2 py-0.5 rounded-md bg-[var(--surface-2)] border border-[var(--border)] w-fit"><Loader2 size={9} className="text-[var(--accent)] animate-spin" /><span className="text-[0.643rem] text-[var(--text-tertiary)]">Working…</span></div>}
          {!subagent.running && subagent.result && <div className="pt-1 border-t border-[var(--border)]"><p className="text-[0.643rem] text-[var(--text-tertiary)] mb-0.5">Result returned to parent</p><p className="text-[0.714rem] text-[var(--text-secondary)] whitespace-pre-wrap">{subagent.result}</p></div>}
        </div>
      )}
    </div>
  );
}
