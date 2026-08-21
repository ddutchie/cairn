"use client";

import React from "react";
import { Loader2, CheckCircle, XCircle } from "lucide-react";
import { MarkdownContent } from "./MarkdownContent";
import { ThinkingPanel } from "./ThinkingPanel";
import { MessageAvatar, StreamingCursor } from "./message-ui";
import { ExternalRefChip } from "@/components/shared/cairn-ref-chip";
import { WritingStylePromptChip, writingStyleNeedsSetup } from "@/components/shared/WritingStylePromptChip";
import { ConnectorToolCard } from "@/components/shared/ConnectorToolCard";
import type { ChatToolCall } from "@/hooks/useChatStream";
import { humanizeTool } from "@/lib/humanize-tool";
import { connectorForTool, parseToolArgs, type ChatConnectorMeta } from "./connector-context";
import { DshToolView, hasToolView } from "@/lib/dsh-toolview";

interface ToolCallIndicatorProps {
  toolCalls: ChatToolCall[];
  streamingContent: string;
  streamingThought?: string;
  connectors?: Record<string, ChatConnectorMeta>;
}

export const ToolCallIndicator = React.memo(function ToolCallIndicator({ toolCalls, streamingContent, streamingThought, connectors }: ToolCallIndicatorProps) {
  const hasThought = !!streamingThought;
  const hasContent = !!streamingContent;
  return (
    <div className="flex gap-2 items-start">
      <MessageAvatar role="bot" size="lg" />
      <div className="flex flex-col gap-1 min-w-0 flex-1">
        {toolCalls.map((tc, i) =>
          hasToolView(tc.tool) ? (
            // §11 spike: a registered dsh `tool.call.toolview` plugin owns this
            // tool's rendering. Cairn hands it a Cairn-built ToolCallViewProps;
            // the dsh component renders inside Cairn's transcript (scoped theme).
            <DshToolView key={i} tc={tc} />
          ) : tc.status === "done" && tc.ok === false ? (
            <div key={i} className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-[color-mix(in_srgb,var(--danger)_8%,transparent)] border border-[color-mix(in_srgb,var(--danger)_30%,transparent)] w-fit max-w-full" title={tc.error}>
              <XCircle size={10} className="text-[var(--danger)] shrink-0" />
              <span className="text-[0.786rem] text-[var(--text-secondary)]">{humanizeTool(tc.tool, parseToolArgs(tc.args)).pre} failed</span>
              {tc.error && <span className="text-[0.714rem] text-[var(--text-tertiary)] truncate max-w-[220px]">— {tc.error}</span>}
            </div>
          ) : tc.status === "done" && tc.tool === "get_user_writing_style" && tc.ok !== false && writingStyleNeedsSetup(tc.output) ? (
            <WritingStylePromptChip key={i} output={tc.output} />
          ) : tc.status === "done" && connectors && connectorForTool(tc.tool, connectors) ? (
            <ConnectorToolCard key={i} toolCall={{ tool: tc.tool, args: parseToolArgs(tc.args), output: tc.output, externalRef: tc.externalRef }} connector={connectorForTool(tc.tool, connectors)!} testId="chat-connector-card" />
          ) : tc.status === "done" && tc.externalRef ? (
            <ExternalRefChip key={i} toolName={tc.tool} externalRef={tc.externalRef} />
          ) : (
            <div key={i} className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-[var(--surface-2)] border border-[var(--border)] w-fit">
              {tc.status === "running" ? (
                <Loader2 size={10} className="text-[var(--accent)] animate-spin shrink-0" />
              ) : (
                <CheckCircle size={10} className="text-[var(--accent)] shrink-0" />
              )}
              {(() => { const summary = humanizeTool(tc.tool, parseToolArgs(tc.args)); return <span className="text-[0.786rem] text-[var(--text-secondary)]">{summary.pre}{summary.obj ? <> <strong className="font-medium text-[var(--text-primary)]">{summary.obj}</strong></> : null}</span>; })()}
            </div>
          )
        )}
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
          <div className="chat-bubble-ai px-3 py-2.5 rounded-xl rounded-tl-sm text-xs leading-relaxed max-w-full">
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
