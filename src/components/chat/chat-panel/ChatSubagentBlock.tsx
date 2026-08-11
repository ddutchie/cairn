"use client";

/**
 * ChatSubagentBlock — expandable inline trace of a subagent-mode run.
 *
 * Renders one dispatch → research/write subagent: its role, the dispatcher's
 * instruction, a live/streamed content brief, its tool-call chips, and the
 * result returned to the dispatcher. Collapsed by default; expand to "step into"
 * what the subagent did. Used both live (during streaming) and persisted.
 */

import React, { useState } from "react";
import { Loader2, GitBranch, Search, PencilLine, ChevronDown, ChevronRight, CheckCircle, XCircle } from "lucide-react";
import { humanizeTool } from "@/lib/humanize-tool";
import { parseToolArgs } from "./connector-context";
import { useCairnStore } from "@/store";
import { MarkdownContent } from "./MarkdownContent";
import { ContextRing } from "@/components/agent/ContextRing";
import { CairnRefChip, ExternalRefChip } from "@/components/shared/cairn-ref-chip";
import { WritingStylePromptChip, writingStyleNeedsSetup } from "@/components/shared/WritingStylePromptChip";
import type { ChatSubagent, ChatToolCallRecord } from "@/types";

function SubToolChip({ tc }: { tc: ChatToolCallRecord }) {
  if (tc.ok === false) {
    return (
      <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-[color-mix(in_srgb,var(--danger)_8%,transparent)] border border-[color-mix(in_srgb,var(--danger)_30%,transparent)] w-fit max-w-full" title={tc.error}>
        <XCircle size={9} className="text-[var(--danger)] shrink-0" />
        {(() => { const summary = humanizeTool(tc.tool, parseToolArgs(tc.args)); return <span className="text-[0.714rem] text-[var(--text-tertiary)]">{summary.pre}{summary.obj ? <> <strong className="font-medium text-[var(--text-secondary)]">{summary.obj}</strong></> : null} failed</span>; })()}
      </div>
    );
  }
  if (tc.cairnRef) return <CairnRefChip toolName={tc.tool} cairnRef={tc.cairnRef} />;
  if (tc.externalRef) return <ExternalRefChip toolName={tc.tool} externalRef={tc.externalRef} />;
  // Writing style not configured — surface the "set up" prompt (the writing
  // subagent is exactly where prose gets drafted in the user's voice).
  if (tc.tool === "get_user_writing_style" && writingStyleNeedsSetup(tc.output)) {
    return <WritingStylePromptChip output={tc.output} />;
  }
  const running = !tc.output;
  return (
    <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-[var(--surface-3)] border border-[var(--border)] w-fit">
      {running
        ? <Loader2 size={9} className="text-[var(--accent)] animate-spin shrink-0" />
        : <CheckCircle size={9} className="text-[var(--accent)] shrink-0" />}
      {(() => { const summary = humanizeTool(tc.tool, parseToolArgs(tc.args)); return <span className="text-[0.714rem] text-[var(--text-tertiary)]">{summary.pre}{summary.obj ? <> <strong className="font-medium text-[var(--text-secondary)]">{summary.obj}</strong></> : null}</span>; })()}
    </div>
  );
}

export function ChatSubagentBlock({ sub }: { sub: ChatSubagent }) {
  const [expanded, setExpanded] = useState(false);
  const contextLimit = useCairnStore((s) => s.aiConfig.contextLimit ?? 128000);
  const roleLabel = sub.role === "research" ? "Research agent" : sub.role === "write" ? "Writing agent" : "Sub-agent";
  const RoleIcon = sub.role === "research" ? Search : sub.role === "write" ? PencilLine : GitBranch;

  return (
    <div className="mt-1 rounded-lg border border-[var(--border)] bg-[var(--surface)] overflow-hidden">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-1.5 px-2.5 py-1.5 hover:bg-[var(--surface-2)] transition-colors text-left"
      >
        {sub.running
          ? <Loader2 size={10} className="text-[var(--accent)] animate-spin shrink-0" />
          : <RoleIcon size={10} className="text-[var(--accent)] shrink-0" />}
        <span className="text-[0.786rem] font-medium text-[var(--text-secondary)] flex-1">
          {sub.running ? `${roleLabel} working…` : roleLabel}
        </span>
        {(sub.toolCalls?.length ?? 0) > 0 && (
          <span className="text-[0.643rem] text-[var(--text-tertiary)]">{sub.toolCalls!.length} tool{sub.toolCalls!.length !== 1 ? "s" : ""}</span>
        )}
        {sub.lastUsage && sub.lastUsage.promptTokens > 0 && (
          <ContextRing
            promptTokens={sub.lastUsage.promptTokens}
            contextLimit={contextLimit}
            breakdown={sub.lastUsage.breakdown}
            completionTokens={sub.lastUsage.completionTokens}
            reasoningTokens={sub.lastUsage.reasoningTokens}
            cacheReadTokens={sub.lastUsage.cacheReadTokens}
            cacheCreationTokens={sub.lastUsage.cacheCreationTokens}
            costUsd={sub.lastUsage.costUsd}
            showBalance={false}
            size={12}
            stroke={1.5}
          />
        )}
        {expanded
          ? <ChevronDown size={10} className="text-[var(--text-tertiary)] shrink-0" />
          : <ChevronRight size={10} className="text-[var(--text-tertiary)] shrink-0" />}
      </button>

      {expanded && (
        <div className="border-t border-[var(--border)] px-2.5 py-2 space-y-2 max-h-96 overflow-y-auto">
          {sub.instruction && (
            <div>
              <p className="text-[0.643rem] uppercase tracking-wide text-[var(--text-tertiary)] mb-0.5">Instruction</p>
              <p className="text-[0.714rem] text-[var(--text-secondary)] whitespace-pre-wrap">{sub.instruction}</p>
            </div>
          )}
          {(sub.toolCalls?.length ?? 0) > 0 && (
            <div className="flex flex-col gap-0.5">
              {sub.toolCalls!.map((tc, i) => <SubToolChip key={i} tc={tc} />)}
            </div>
          )}
          {sub.content && (
            <div>
              <p className="text-[0.643rem] uppercase tracking-wide text-[var(--text-tertiary)] mb-0.5">
                {sub.role === "write" ? "Confirmation" : "Findings brief"}
              </p>
              <div className="px-2 py-1 rounded-md bg-[var(--surface-2)] border border-[var(--border)] text-[0.714rem] text-[var(--text-secondary)]">
                <MarkdownContent content={sub.content} />
              </div>
            </div>
          )}
          {!sub.content && sub.running && (
            <div className="flex items-center gap-1 px-2 py-0.5 rounded-md bg-[var(--surface-2)] border border-[var(--border)] w-fit">
              <Loader2 size={9} className="text-[var(--accent)] animate-spin shrink-0" />
              <span className="text-[0.643rem] text-[var(--text-tertiary)]">Working…</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
