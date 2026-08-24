"use client";

import React, { useState } from "react";
import { CheckCircle, XCircle, Loader2, ChevronDown, ChevronRight, GitBranch, ShieldAlert, Globe2, FileText } from "lucide-react";
import { cn, prettifyToolLabel } from "@/lib/utils";
import { MarkdownContent } from "@/components/chat/chat-panel/MarkdownContent";
import { MessageAvatar, StreamingCursor } from "@/components/chat/chat-panel/message-ui";
import { ThinkingPanel } from "@/components/chat/chat-panel/ThinkingPanel";
import { CairnRefChip } from "@/components/shared/cairn-ref-chip";
import { WritingStylePromptChip, writingStyleNeedsSetup } from "@/components/shared/WritingStylePromptChip";
import { useCairnStore } from "@/store";
import { ContextRing } from "./ContextRing";
import type { PiAgentMessage, PiSubagentMessage } from "@/types";
import { humanizeTool } from "@/lib/humanize-tool";
import { approvalPreview, riskForTool, approvalGrantScope, approvalScopeLabel } from "@/lib/tool-risk";
import { ConnectorToolCard, type ConnectorMeta } from "@/components/shared/ConnectorToolCard";
import { normalizeContextLimit } from "../../../shared/models/model-catalog";

export type AgentConnectorMeta = ConnectorMeta;

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
              line.type === "add"    && "bg-[color-mix(in_srgb,var(--success)_10%,transparent)] text-[color-mix(in_srgb,var(--success)_90%,var(--text-primary))]",
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

function ApprovalCard({ tc, sessionId }: { tc: ToolChipProps["tc"]; sessionId: string }) {
  const risk = riskForTool(tc.name);
  const humanized = humanizeTool(tc.name, tc.args);
  const preview = approvalPreview(tc.name, tc.args);
  const scope = approvalScopeLabel(tc.name);
  const grant = approvalGrantScope(tc.name);

  return (
    <div data-testid="approval-card" className="w-full max-w-xl rounded-lg border border-[color-mix(in_srgb,var(--warning,#f59e0b)_45%,var(--border))] bg-[color-mix(in_srgb,var(--warning,#f59e0b)_6%,var(--surface))] px-3 py-2.5">
      <div className="flex items-start gap-2">
        {risk === "EXTERNAL" ? <Globe2 size={14} className="mt-0.5 text-[var(--warning,#f59e0b)] shrink-0" /> : <ShieldAlert size={14} className="mt-0.5 text-[var(--warning,#f59e0b)] shrink-0" />}
        <div className="min-w-0 flex-1">
          <p className="text-[0.786rem] font-medium text-[var(--text-primary)]">
            {humanized.pre}{humanized.obj ? <> <strong className="font-semibold">{humanized.obj}</strong></> : null}{humanized.post ? ` ${humanized.post}` : ""}
          </p>
          <p className="mt-0.5 text-[0.643rem] text-[var(--text-tertiary)]">This {scope}.</p>
        </div>
        <span className="text-[0.607rem] font-semibold tracking-wide text-[var(--warning,#f59e0b)]">{risk}</span>
      </div>
      {preview && <pre data-testid="approval-preview" className="mt-2 max-h-24 overflow-hidden rounded border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-[0.643rem] leading-4 text-[var(--text-secondary)] whitespace-pre-wrap break-words">{preview}</pre>}
      <div className="mt-2 flex items-center justify-end gap-1.5">
        <button data-testid="approval-deny" onClick={() => window.electron?.piAgent.respondTool(sessionId, tc.callId, false)} className="px-2 py-1 text-[0.643rem] text-[var(--text-tertiary)] hover:text-[var(--text-primary)] rounded transition-colors">Deny</button>
        {grant === "command" && <button data-testid="approval-allow-command" onClick={() => window.electron?.piAgent.respondTool(sessionId, tc.callId, true, "command", typeof tc.args?.command === "string" ? tc.args.command : undefined)} className="px-2 py-1 text-[0.643rem] text-[var(--text-secondary)] hover:text-[var(--text-primary)] rounded transition-colors">Always allow this command</button>}
        {grant === "session" && <button data-testid="approval-allow-session" onClick={() => window.electron?.piAgent.respondTool(sessionId, tc.callId, true, "session")} className="px-2 py-1 text-[0.643rem] text-[var(--text-secondary)] hover:text-[var(--text-primary)] rounded transition-colors">Always allow this tool</button>}
        <button data-testid="approval-allow-once" onClick={() => window.electron?.piAgent.respondTool(sessionId, tc.callId, true)} className="px-2.5 py-1 text-[0.643rem] font-semibold text-white bg-[var(--accent)] hover:opacity-90 rounded transition-opacity">Allow once</button>
      </div>
    </div>
  );
}

interface ToolChipProps {
  tc: { callId: string; name: string; label: string; args?: Record<string, unknown>; running?: boolean; ok: boolean; output?: string; cairnRef?: { type: "note" | "task"; id: string; title: string }; confirmRequired?: boolean };
  sessionId?: string;
  connectors?: Record<string, AgentConnectorMeta>;
}

function connectorForTool(toolName: string, connectors?: Record<string, AgentConnectorMeta>): AgentConnectorMeta | undefined {
  if (!connectors || !/^(?:mcp|svc)__.+__/.test(toolName)) return undefined;
  return Object.entries(connectors).find(([key]) => toolName.startsWith(key))?.[1];
}

function ToolChip({ tc, sessionId, connectors }: ToolChipProps) {
  const [expanded, setExpanded] = useState(false);

  // While paused waiting for user confirmation
  if (tc.confirmRequired && sessionId && tc.callId) return <ApprovalCard tc={tc} sessionId={sessionId} />;

  // While running — show a spinner chip, not expandable
  if (tc.running) {
    return (
      <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-[var(--surface-2)] border border-[var(--border)] w-fit">
        <Loader2 size={9} className="text-[var(--accent)] animate-spin shrink-0" />
        <span className="text-[0.714rem] text-[var(--text-secondary)]">{prettifyToolLabel(tc.label)}</span>
      </div>
    );
  }

  // No writing style configured — surface a "set up" chip instead of a plain
  // success chip so the user knows the agent couldn't match their voice.
  if (tc.name === "get_user_writing_style" && tc.ok && writingStyleNeedsSetup(tc.output)) {
    return <WritingStylePromptChip output={tc.output} />;
  }

  // Cairn write tools get a dedicated linked bubble instead of raw JSON expansion
  if (tc.cairnRef && tc.ok) {
    return <CairnRefChip toolName={tc.name} cairnRef={tc.cairnRef} ok={tc.ok} />;
  }

  const connector = connectorForTool(tc.name, connectors);
  if (connector && tc.ok) return <ConnectorToolCard toolCall={{ tool: tc.name, args: tc.args, output: tc.output }} connector={connector} />;

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
        {tc.ok ? (
          <CheckCircle size={9} className="shrink-0 text-[var(--accent)]" />
        ) : (
          <XCircle size={9} className="shrink-0 text-[var(--danger)]" />
        )}
        {(() => { const summary = humanizeTool(tc.name, tc.args); return <span className="text-[0.714rem] text-[var(--text-secondary)]">{summary.pre}{summary.obj ? <> <strong className="font-medium text-[var(--text-primary)]">{summary.obj}</strong></> : null}{tc.ok === false && " failed"}</span>; })()}
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
  // The subagent runs the CODING AGENT's model (inherits the parent's llmConfig),
  // so its context ring must use the agent's context limit — NOT the chat AI
  // config (a different model's limit, e.g. a 200K chat model would otherwise
  // cap every agent subagent ring at 200K regardless of the agent model).
  // Shared normalization with the pruner so ring and runtime enforce the same limit.
  const contextLimit = useCairnStore((s) => normalizeContextLimit(s.agentConfig.contextLimit));

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
  const hasReasoning = !!msg.reasoning;

  return (
    <div className="flex gap-1.5 items-start">
      <MessageAvatar role="bot" size="sm" />
      <div className="flex-1 min-w-0 flex flex-col gap-0.5">
        {hasTools && (
          <div className="flex flex-col gap-0.5">
            {msg.toolCalls!.map((tc, i) => (
              // Stable key: dsh's callId survives array reshuffles / dedup so
              // the SkillRow disclosure state can't open on the wrong chip.
              <ToolChip key={tc.callId ?? `${tc.name}-${i}`} tc={tc} sessionId={sessionId} />
            ))}
          </div>
        )}
        {hasReasoning && (
          <ThinkingPanel
            text={msg.reasoning!}
            streaming={!!msg.isStreaming}
            companionContent={msg.content}
          />
        )}
        {!hasContent && msg.isStreaming && !hasTools && !hasReasoning && (
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
  connectors?: Record<string, AgentConnectorMeta>;
}

export const AgentMessageBubble = React.memo(function AgentMessageBubble({ message, sessionId, connectors }: AgentMessageBubbleProps) {
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
    const hasImages = (message.images?.length ?? 0) > 0;
    return (
      <div className="flex gap-2 items-start justify-end">
        <div className="flex-1 min-w-0 flex flex-col items-end gap-1">
          {hasImages && (
            <div className="flex flex-wrap gap-2 justify-end">
              {message.images!.map((img, i) =>
                img.kind === "pdf" ? (
                  <div
                    key={`${img.name}-${i}`}
                    className="max-w-[200px] rounded-lg border border-[var(--border)] bg-[var(--surface-2)] flex items-center gap-2 px-3 py-2"
                    title={img.name}
                  >
                    <FileText size={14} className="text-[var(--danger)] shrink-0" />
                    <span className="text-[0.714rem] text-[var(--text-secondary)] truncate">{img.name}</span>
                  </div>
                ) : (
                  <img
                    key={`${img.name}-${i}`}
                    src={img.url}
                    alt={img.name}
                    className="max-w-[200px] max-h-[200px] rounded-lg border border-[var(--border)] object-cover"
                  />
                )
              )}
            </div>
          )}
          <div className="px-3 py-2 rounded-xl rounded-tr-sm text-xs leading-relaxed bg-[var(--accent)] text-[var(--accent-fg)] max-w-[85%]">
            <MarkdownContent content={message.content} isUser />
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
  const hasReasoning = !!message.reasoning;

  return (
    <div className="flex gap-2 items-start">
      <MessageAvatar role="bot" size="md" />
      <div className="flex-1 min-w-0 flex flex-col gap-1">

        {/* Subagent inline blocks */}
        {hasSubagents && message.subagents!.map((sub) => (
          <SubagentBlock key={sub.childSessionId} sub={sub} />
        ))}

        {/* Tool call chips — expandable. Rendered ABOVE the message content to
            match chat: the user sees the tool activity first, then the reply. */}
        {hasTools && (
          <div className="flex flex-col gap-0.5">
            {message.toolCalls!.map((tc, i) => (
              <ToolChip key={tc.callId ?? `${tc.name}-${i}`} tc={tc} sessionId={sessionId} connectors={connectors} />
            ))}
          </div>
        )}

        {/* Reasoning / thinking panel — collapsible */}
        {hasReasoning && (
          <ThinkingPanel
            text={message.reasoning!}
            streaming={!!message.isStreaming}
            companionContent={message.content}
          />
        )}

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

        {/* "Thinking…" spinner — only when streaming with no content/tools/reasoning yet */}
        {!hasContent && message.isStreaming && !hasTools && !hasSubagents && !hasReasoning && (
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
  return prev.message === next.message && prev.sessionId === next.sessionId && prev.connectors === next.connectors;
});
