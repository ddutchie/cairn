"use client";

import React from "react";
import { Loader2, CheckCircle, XCircle } from "lucide-react";
import { MarkdownContent } from "./MarkdownContent";
import { ThinkingPanel } from "./ThinkingPanel";
import { MessageAvatar, StreamingCursor } from "./message-ui";
import { CairnRefChip, ExternalRefChip, extractCairnRef, type CairnRef } from "@/components/shared/cairn-ref-chip";
import { WritingStylePromptChip, writingStyleNeedsSetup } from "@/components/shared/WritingStylePromptChip";


import { ConnectorToolCard } from "@/components/shared/ConnectorToolCard";
import type { ChatToolCall } from "@/hooks/useChatStream";
import { humanizeTool } from "@/lib/humanize-tool";
import { connectorForTool, parseToolArgs, type ChatConnectorMeta } from "./connector-context";
import { registerBuiltinToolViews } from "@/lib/dsh-toolview";
import { toToolCallViewProps } from "@/lib/dsh-toolview/adapter";
import { KeyedSlotOutlet } from "@/lib/plugin-ui/SlotOutlet";
import { useSlotEntries } from "@/lib/plugin-ui/registry";

// Ensure the built-in (vendored) toolviews are registered into the unified
// plugin-ui slot registry before we check it.
registerBuiltinToolViews();

interface ToolCallIndicatorProps {
  toolCalls: ChatToolCall[];
  streamingContent: string;
  streamingThought?: string;
  connectors?: Record<string, ChatConnectorMeta>;
}

/**
 * A single tool-call rendered through a registered dsh tool.call.toolview
 * (SkillRow / visualize / …), memoised so a per-token parent re-render
 * doesn't rebuild the props object and reset plugin-local state (e.g. the
 * SkillRow disclosure open/closed flag). Memo is scoped to what actually
 * changes the visual: callId (identity), status, ok, output, args.
 */
const MemoToolViewChip = React.memo(
  function MemoToolViewChip({ tc }: { tc: ChatToolCall }) {
    // Recompute the props object only when a discriminating field of `tc`
    // changes. The ChatToolCall reference itself is recreated on every
    // stream tick even when its contents don't change, so we can't cache
    // by reference.
    const props = React.useMemo(
      () => toToolCallViewProps(tc),
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [tc.callId, tc.tool, tc.status, tc.ok, tc.output, tc.args, tc.cairnRef, tc.externalRef],
    );
    return (
      <KeyedSlotOutlet name="tool.call.toolview" matchKey={tc.tool} props={props} />
    );
  },
  (prev, next) =>
    prev.tc.callId === next.tc.callId &&
    prev.tc.tool === next.tc.tool &&
    prev.tc.status === next.tc.status &&
    prev.tc.ok === next.tc.ok &&
    prev.tc.output === next.tc.output &&
    prev.tc.args === next.tc.args &&
    prev.tc.cairnRef === next.tc.cairnRef &&
    prev.tc.externalRef === next.tc.externalRef,
);

export const ToolCallIndicator = React.memo(function ToolCallIndicator({ toolCalls, streamingContent, streamingThought, connectors }: ToolCallIndicatorProps) {
  const hasThought = !!streamingThought;
  const hasContent = !!streamingContent;
  // Reactive set of tool names with a registered tool.call.toolview (so a plugin
  // that registers after first render still routes its calls to the view).
  const toolViewEntries = useSlotEntries("tool.call.toolview");
  const toolViewKeys = new Set(toolViewEntries.map((e) => e.key).filter(Boolean) as string[]);
  return (
    <div className="flex gap-2 items-start">
      <MessageAvatar role="bot" size="lg" />
      <div className="flex flex-col gap-1 min-w-0 flex-1">
        {toolCalls.map((tc, i) =>
          toolViewKeys.has(tc.tool) ? (
            // A registered tool.call.toolview (dsh-compatible, keyed by tool name)
            // owns this tool's rendering — vendored SkillRow or a user/community
            // plugin (e.g. visualize). MemoToolViewChip memoises the
            // toToolCallViewProps() call so a per-token parent re-render
            // doesn't recreate the props object identity, which was
            // remounting the plugin's SkillRow-style disclosure state on
            // every stream tick.
            <MemoToolViewChip key={tc.callId ?? `${tc.tool}-${i}`} tc={tc} />
          ) : tc.status === "done" && tc.ok === false ? (
            <div key={tc.callId ?? `${tc.tool}-${i}`} className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-[color-mix(in_srgb,var(--danger)_8%,transparent)] border border-[color-mix(in_srgb,var(--danger)_30%,transparent)] w-fit max-w-full" title={tc.error}>
              <XCircle size={10} className="text-[var(--danger)] shrink-0" />
              <span className="text-[0.786rem] text-[var(--text-secondary)]">{humanizeTool(tc.tool, parseToolArgs(tc.args)).pre} failed</span>
              {tc.error && <span className="text-[0.714rem] text-[var(--text-tertiary)] truncate max-w-[220px]">— {tc.error}</span>}
            </div>
          ) : tc.status === "done" && tc.tool === "get_user_writing_style" && tc.ok !== false && writingStyleNeedsSetup(tc.output) ? (
            <WritingStylePromptChip key={tc.callId ?? `${tc.tool}-${i}`} output={tc.output} />
          ) : tc.status === "done" && connectors && connectorForTool(tc.tool, connectors) ? (
            <ConnectorToolCard key={tc.callId ?? `${tc.tool}-${i}`} toolCall={{ tool: tc.tool, args: parseToolArgs(tc.args), output: tc.output, externalRef: tc.externalRef }} connector={connectorForTool(tc.tool, connectors)!} testId="chat-connector-card" />
          ) : tc.status === "done" && (tc.cairnRef || (tc.meta as { cairnRef?: CairnRef })?.cairnRef || extractCairnRef(tc.tool, tc.output)) ? (
            <CairnRefChip key={tc.callId ?? `${tc.tool}-${i}`} toolName={tc.tool} cairnRef={(tc.cairnRef || (tc.meta as { cairnRef?: CairnRef })?.cairnRef || extractCairnRef(tc.tool, tc.output))!} />
          ) : tc.status === "done" && tc.externalRef ? (

            <ExternalRefChip key={tc.callId ?? `${tc.tool}-${i}`} toolName={tc.tool} externalRef={tc.externalRef} />
          ) : (

            <div key={tc.callId ?? `${tc.tool}-${i}`} className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-[var(--surface-2)] border border-[var(--border)] w-fit">
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
        ) : !hasThought && toolCalls.length === 0 ? (
          <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-[var(--surface-2)] border border-[var(--border)] w-fit">
            <Loader2 size={10} className="text-[var(--accent)] animate-spin shrink-0" />
            <span className="text-[0.786rem] text-[var(--text-tertiary)]">Thinking…</span>
          </div>
        ) : null}

      </div>
    </div>
  );
});
