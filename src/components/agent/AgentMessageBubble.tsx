"use client";

import React, { useState } from "react";
import { CheckCircle, Loader2, ChevronDown, ChevronRight, GitBranch } from "lucide-react";
import { cn } from "@/lib/utils";
import { MarkdownContent } from "@/components/chat/chat-panel/MarkdownContent";
import { MessageAvatar, StreamingCursor } from "@/components/chat/chat-panel/message-ui";
import { CairnRefChip } from "@/components/shared/cairn-ref-chip";
import { useCairnStore } from "@/store";
import { ContextRing } from "./ContextRing";
import type { PiAgentMessage, PiSubagentMessage } from "@/store/slices/terminal-sessions";

// ── Tool output expansion ─────────────────────────────────────────────────────

function parseDiff(output: string): { type: "add" | "remove" | "context"; text: string }[] | null {
  const lines = output.split("\n");
  // Heuristic: looks like a diff if it starts with --- or +++ or has @@ lines
  const isDiff = lines.some((l) => l.startsWith("---") || l.startsWith("+++") || l.startsWith("@@"));
  if (!isDiff) return null;
  return lines.map((text) => {
    if (text.startsWith("+") && !text.startsWith("+++")) return { type: "add" as const, text };
    if (text.startsWith("-") && !text.startsWith("---")) return { type: "remove" as const, text };
    return { type: "context" as const, text };
  });
}

function ToolOutputPanel({ name, output }: { name: string; output: string }) {
  const diff = (name === "edit") ? parseDiff(output) : null;

  if (diff) {
    return (
      <div className="mt-1 rounded-md border border-[var(--border)] overflow-hidden text-[0.643rem] font-mono">
        {diff.map((line, i) => (
          <div
            key={i}
            className={cn(
              "px-2 py-px leading-5 whitespace-pre-wrap break-all",
              line.type === "add"    && "bg-[color-mix(in_srgb,var(--success,#22c55e)_10%,transparent)] text-[color-mix(in_srgb,var(--success,#22c55e)_90%,var(--text-primary))]",
              line.type === "remove" && "bg-[color-mix(in_srgb,var(--danger)_10%,transparent)] text-[color-mix(in_srgb,var(--danger)_80%,var(--text-primary))]",
              line.type === "context" && "text-[var(--text-tertiary)]",
            )}
          >
            {line.text || "\u00a0"}
          </div>
        ))}
      </div>
    );
  }

  return (
    <pre className="mt-1 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-[0.643rem] font-mono text-[var(--text-secondary)] overflow-x-auto max-h-48 overflow-y-auto whitespace-pre-wrap break-all leading-5">
      {output || "(no output)"}
    </pre>
  );
}

function ToolChip({ tc, sessionId }: {
  tc: { callId?: string; name: string; label: string; running?: boolean; ok: boolean; output?: string; cairnRef?: { type: "note" | "task"; id: string; title: string }; confirmRequired?: boolean };
  sessionId?: string;
}) {
  const [expanded, setExpanded] = useState(false);

  // While paused waiting for user confirmation
  if (tc.confirmRequired && sessionId && tc.callId) {
    return (
      <div className="flex items-center gap-2 px-2.5 py-1 rounded-md bg-[color-mix(in_srgb,var(--warning,#f59e0b)_8%,transparent)] border border-[color-mix(in_srgb,var(--warning,#f59e0b)_30%,transparent)] w-fit flex-wrap mt-0.5 mb-0.5">
        <span className="text-[0.714rem] font-medium text-[var(--warning,#f59e0b)] flex items-center gap-1.5 shrink-0">
          <Loader2 size={9} className="animate-spin shrink-0" />
          Confirm: {tc.label}
        </span>
        <div className="flex items-center gap-1.5 ml-2">
          <button
            onClick={() => window.electron?.piAgent.respondTool(sessionId, tc.callId!, true)}
            className="px-2 py-0.5 text-[0.643rem] font-semibold bg-[var(--success,#22c55e)] hover:opacity-90 text-white rounded transition-opacity cursor-pointer flex items-center gap-1"
          >
            Confirm
          </button>
          <button
            onClick={() => window.electron?.piAgent.respondTool(sessionId, tc.callId!, false)}
            className="px-2 py-0.5 text-[0.643rem] font-semibold bg-[var(--danger,#ef4444)] hover:opacity-90 text-white rounded transition-opacity cursor-pointer flex items-center gap-1"
          >
            Deny
          </button>
        </div>
      </div>
    );
  }

  // While running — show a spinner chip, not expandable
  if (tc.running) {
    return (
      <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-[var(--surface-2)] border border-[var(--border)] w-fit">
        <Loader2 size={9} className="text-[var(--accent)] animate-spin shrink-0" />
        <span className="text-[0.714rem] text-[var(--text-secondary)]">{tc.label}</span>
      </div>
    );
  }

  // Cairn write tools get a dedicated linked bubble instead of raw JSON expansion
  if (tc.cairnRef && tc.ok) {
    return <CairnRefChip toolName={tc.name} cairnRef={tc.cairnRef} ok={tc.ok} />;
  }

  const hasOutput = !!tc.output;

  return (
    <div>
      <button
        onClick={() => hasOutput && setExpanded((v) => !v)}
        className={cn(
          "flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-[var(--surface-2)] border border-[var(--border)] w-fit text-left",
          hasOutput && "hover:border-[var(--accent)]/40 cursor-pointer transition-colors",
          !hasOutput && "cursor-default",
        )}
      >
        <CheckCircle size={9} className={cn("shrink-0", tc.ok ? "text-[var(--accent)]" : "text-[var(--danger)]")} />
        <span className="text-[0.714rem] text-[var(--text-secondary)]">{tc.label}</span>
        {hasOutput && (
          expanded
            ? <ChevronDown size={9} className="text-[var(--text-tertiary)] shrink-0 ml-0.5" />
            : <ChevronRight size={9} className="text-[var(--text-tertiary)] shrink-0 ml-0.5" />
        )}
      </button>
      {expanded && tc.output && (
        <ToolOutputPanel name={tc.name} output={tc.output} />
      )}
    </div>
  );
}

// ── Subagent inline block ─────────────────────────────────────────────────────

function SubagentBlock({ sub }: { sub: PiSubagentMessage }) {
  const [expanded, setExpanded] = useState(false);
  const contextLimit = useCairnStore((s) => s.aiConfig.contextLimit ?? 128000);

  return (
    <div className="mt-1 rounded-lg border border-[var(--border)] bg-[var(--surface)] overflow-hidden">
      {/* Header */}
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-1.5 px-2.5 py-1.5 hover:bg-[var(--surface-2)] transition-colors text-left"
      >
        {sub.running
          ? <Loader2 size={9} className="text-[var(--accent)] animate-spin shrink-0" />
          : <GitBranch size={9} className="text-[var(--accent)] shrink-0" />
        }
        <span className="text-[0.714rem] font-medium text-[var(--text-secondary)] flex-1">
          {sub.running ? "Sub-agent working…" : "Sub-agent"}
        </span>
        {sub.lastUsage && (
          <ContextRing
            promptTokens={sub.lastUsage.promptTokens}
            contextLimit={contextLimit}
            breakdown={sub.lastUsage.breakdown}
            size={12}
            stroke={1.5}
          />
        )}
        {expanded
          ? <ChevronDown size={9} className="text-[var(--text-tertiary)] shrink-0" />
          : <ChevronRight size={9} className="text-[var(--text-tertiary)] shrink-0" />
        }
      </button>

      {/* Expanded trace */}
      {expanded && (
        <div className="border-t border-[var(--border)] px-2.5 py-2 space-y-2 max-h-96 overflow-y-auto">
          {sub.messages.length === 0 && (
            <p className="text-[0.643rem] text-[var(--text-tertiary)]">Waiting…</p>
          )}
          {sub.messages.map((msg) => (
            <SubagentMessageRow key={msg.id} msg={msg} sessionId={sub.childSessionId} />
          ))}
          {!sub.running && sub.result && (
            <div className="mt-1 pt-1 border-t border-[var(--border)]">
              <p className="text-[0.643rem] text-[var(--text-tertiary)] mb-0.5">Result returned to parent:</p>
              <p className="text-[0.714rem] text-[var(--text-secondary)] whitespace-pre-wrap">{sub.result}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function SubagentMessageRow({ msg, sessionId }: { msg: PiAgentMessage; sessionId?: string }) {
  const hasTools = (msg.toolCalls?.length ?? 0) > 0;
  const hasContent = msg.content.length > 0;

  return (
    <div className="flex gap-1.5 items-start">
      <MessageAvatar role="bot" size="sm" />
      <div className="flex-1 min-w-0 flex flex-col gap-0.5">
        {hasTools && (
          <div className="flex flex-col gap-0.5">
            {msg.toolCalls!.map((tc, i) => (
              <ToolChip key={i} tc={tc} sessionId={sessionId} />
            ))}
          </div>
        )}
        {!hasContent && msg.isStreaming && !hasTools && (
          <div className="flex items-center gap-1 px-2 py-0.5 rounded-md bg-[var(--surface-2)] border border-[var(--border)] w-fit">
            <Loader2 size={8} className="text-[var(--accent)] animate-spin shrink-0" />
            <span className="text-[0.643rem] text-[var(--text-tertiary)]">Thinking…</span>
          </div>
        )}
        {hasContent && (
          <div className="px-2 py-1 rounded-lg text-[0.643rem] leading-relaxed bg-[var(--surface-2)] border border-[var(--border)] text-[var(--text-secondary)]">
            <MarkdownContent content={msg.content} />
            {msg.isStreaming && <StreamingCursor size="sm" />}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Main bubble ───────────────────────────────────────────────────────────────

interface AgentMessageBubbleProps {
  message: PiAgentMessage;
  sessionId?: string;
}

export const AgentMessageBubble = React.memo(function AgentMessageBubble({ message, sessionId }: AgentMessageBubbleProps) {
  const isUser   = message.role === "user";
  const isError  = message.role === "error";
  const isSystem = message.role === "system";

  // SYSTEM bubble — centred, muted, italic — used for slash command feedback
  if (isSystem) {
    return (
      <div className="flex justify-center py-0.5">
        <span className="text-[0.643rem] italic text-[var(--text-tertiary)] px-2">{message.content}</span>
      </div>
    );
  }

  // USER bubble — right-aligned, accent background, User icon
  if (isUser) {
    return (
      <div className="flex gap-2 items-start justify-end">
        <div className="flex-1 min-w-0 flex flex-col items-end gap-1">
          <div className="px-3 py-2 rounded-xl rounded-tr-sm text-xs leading-relaxed bg-[var(--accent)] text-white max-w-[85%]">
            <MarkdownContent content={message.content} />
          </div>
        </div>
        <MessageAvatar role="user" size="md" />
      </div>
    );
  }

  // ERROR bubble — left-aligned, danger colours, AlertCircle icon
  if (isError) {
    return (
      <div className="flex gap-2 items-start">
        <MessageAvatar role="error" size="md" />
        <div className="flex-1 min-w-0">
          <div className="px-3 py-2 rounded-xl rounded-tl-sm text-xs leading-relaxed bg-[color-mix(in_srgb,var(--danger)_8%,transparent)] border border-[var(--danger)]/20 text-[var(--danger)]">
            {message.content}
          </div>
        </div>
      </div>
    );
  }

  // ASSISTANT bubble — left-aligned, Bot icon, surface-2 background
  const hasContent  = message.content.length > 0;
  const hasTools    = (message.toolCalls?.length ?? 0) > 0;
  const hasSubagents = (message.subagents?.length ?? 0) > 0;

  return (
    <div className="flex gap-2 items-start">
      <MessageAvatar role="bot" size="md" />
      <div className="flex-1 min-w-0 flex flex-col gap-1">

        {/* Markdown content with animated cursor when streaming */}
        {hasContent && (
          <div className={cn(
            "px-3 py-2 rounded-xl rounded-tl-sm text-xs leading-relaxed",
            "bg-[var(--surface-2)] border border-[var(--border)] text-[var(--text-secondary)]",
            "min-w-0 overflow-hidden",
          )}>
            <MarkdownContent content={message.content} />
            {message.isStreaming && <StreamingCursor size="md" />}
          </div>
        )}

        {/* Tool call chips — expandable */}
        {hasTools && (
          <div className="flex flex-col gap-0.5">
            {message.toolCalls!.map((tc, i) => (
              <ToolChip key={i} tc={tc} sessionId={sessionId} />
            ))}
          </div>
        )}

        {/* Subagent inline blocks */}
        {hasSubagents && message.subagents!.map((sub) => (
          <SubagentBlock key={sub.childSessionId} sub={sub} />
        ))}


        {/* "Thinking…" spinner — only when streaming with no content or tools yet */}
        {!hasContent && message.isStreaming && !hasTools && !hasSubagents && (
          <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-[var(--surface-2)] border border-[var(--border)] w-fit">
            <Loader2 size={9} className="text-[var(--accent)] animate-spin shrink-0" />
            <span className="text-[0.714rem] text-[var(--text-tertiary)]">Thinking…</span>
          </div>
        )}
      </div>
    </div>
  );
}, (prev, next) => {
  // Only re-render when the message object or sessionId actually changes.
  // This prevents cascading re-renders of all previous bubbles when a new
  // token appends to the last streaming message.
  return prev.message === next.message && prev.sessionId === next.sessionId;
});
