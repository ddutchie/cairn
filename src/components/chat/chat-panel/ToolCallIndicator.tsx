"use client";

import React from "react";
import { Loader2, CheckCircle, XCircle } from "lucide-react";
import { MarkdownContent } from "./MarkdownContent";
import { ThinkingPanel } from "./ThinkingPanel";
import { MessageAvatar, StreamingCursor } from "./message-ui";
import { ExternalRefChip } from "@/components/shared/cairn-ref-chip";
import type { ChatToolCall } from "@/hooks/useChatStream";
import { humanizeTool } from "@/lib/humanize-tool";
import { ConnectorLogo } from "@/components/settings/tools/ConnectorLogo";
import { connectorForTool, parseToolArgs, type ChatConnectorMeta } from "./connector-context";

interface ToolCallIndicatorProps {
  toolCalls: ChatToolCall[];
  streamingContent: string;
  streamingThought?: string;
  connectors?: Record<string, ChatConnectorMeta>;
}

function ConnectorToolCard({ tc, connector }: { tc: ChatToolCall; connector: ChatConnectorMeta }) {
  const summary = humanizeTool(tc.tool, parseToolArgs(tc.args));
  return (
    <div data-testid="chat-connector-card" className="flex items-start gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] overflow-hidden w-full max-w-xl">
      <div className="w-1 self-stretch shrink-0" style={{ background: connector.brandColor || "var(--accent)" }} />
      <div className="flex items-start gap-2 min-w-0 flex-1 px-2.5 py-2">
        <ConnectorLogo iconSvg={connector.iconSvg} kind={connector.kind} color={connector.brandColor} size={24} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="text-[0.714rem] font-semibold text-[var(--text-primary)] truncate">{connector.label || connector.name}</span>
            <span className="text-[0.607rem] text-[var(--text-tertiary)]">via {connector.kind === "mcp" ? "MCP" : "HTTP service"}</span>
          </div>
          <p className="mt-0.5 text-[0.714rem] text-[var(--text-secondary)]">{summary.pre}{summary.obj ? <> <strong className="font-medium text-[var(--text-primary)]">{summary.obj}</strong></> : null}</p>
          {tc.output && <p className="mt-1 text-[0.643rem] text-[var(--text-tertiary)] line-clamp-2">{tc.output}</p>}
          {tc.externalRef && <div className="mt-1"><ExternalRefChip toolName={tc.tool} externalRef={tc.externalRef} /></div>}
        </div>
      </div>
    </div>
  );
}

export const ToolCallIndicator = React.memo(function ToolCallIndicator({ toolCalls, streamingContent, streamingThought, connectors }: ToolCallIndicatorProps) {
  const hasThought = !!streamingThought;
  const hasContent = !!streamingContent;
  return (
    <div className="flex gap-2 items-start">
      <MessageAvatar role="bot" size="lg" />
      <div className="flex flex-col gap-1 min-w-0 flex-1">
        {toolCalls.map((tc, i) =>
          tc.status === "done" && tc.ok === false ? (
            <div key={i} className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-[color-mix(in_srgb,var(--danger)_8%,transparent)] border border-[color-mix(in_srgb,var(--danger)_30%,transparent)] w-fit max-w-full" title={tc.error}>
              <XCircle size={10} className="text-[var(--danger)] shrink-0" />
              <span className="text-[0.786rem] text-[var(--text-secondary)]">{humanizeTool(tc.tool, parseToolArgs(tc.args)).pre} failed</span>
              {tc.error && <span className="text-[0.714rem] text-[var(--text-tertiary)] truncate max-w-[220px]">— {tc.error}</span>}
            </div>
          ) : tc.status === "done" && connectors && connectorForTool(tc.tool, connectors) ? (
            <ConnectorToolCard key={i} tc={tc} connector={connectorForTool(tc.tool, connectors)!} />
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
