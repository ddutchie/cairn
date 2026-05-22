"use client";

import React, { useState } from "react";
import { CheckCircle, Loader2, ChevronDown, ChevronRight, GitBranch, FileText, SquareCheck } from "lucide-react";
import { cn } from "@/lib/utils";
import { MarkdownContent } from "@/components/chat/chat-panel/MarkdownContent";
import { MessageAvatar, StreamingCursor } from "@/components/chat/chat-panel/message-ui";
import { CairnEvents } from "@/lib/events";
import { useCairnStore } from "@/store";
import { ContextRing } from "./ContextRing";
import type { PiAgentMessage, PiSubagentMessage } from "@/store/slices/terminal-sessions";

// ── Cairn item reference chip ─────────────────────────────────────────────────

const CAIRN_NOTE_ACTIONS: Record<string, string> = {
  create_note:     "Created note",
  ensure_note:     "Saved note",
  update_note:     "Updated note",
  patch_note:      "Patched note",
  append_to_note:  "Appended to note",
};
const CAIRN_TASK_ACTIONS: Record<string, string> = {
  create_task:        "Created task",
  update_task:        "Updated task",
  update_task_status: "Moved task",
};

function CairnRefChip({ tc }: {
  tc: { name: string; ok: boolean; cairnRef: { type: "note" | "task"; id: string; title: string } };
}) {
  const setView = useCairnStore((s) => s.setView);
  const isNote = tc.cairnRef.type === "note";
  const actionLabel = isNote
    ? (CAIRN_NOTE_ACTIONS[tc.name] ?? "Updated note")
    : (CAIRN_TASK_ACTIONS[tc.name] ?? "Updated task");

  function handleClick() {
    if (isNote) {
      setView("notes");
      // Defer so NotesView has one render cycle to mount its cairn:select-note listener
      setTimeout(() => window.dispatchEvent(CairnEvents.selectNote(tc.cairnRef.id)), 50);
    } else {
      setView("board");
      // Defer so KanbanBoard has one render cycle to mount its cairn:open-card listener
      setTimeout(() => window.dispatchEvent(CairnEvents.openCard(tc.cairnRef.id)), 50);
    }
  }

  return (
    <button
      onClick={handleClick}
      className={cn(
        "flex items-center gap-2 px-2.5 py-1.5 rounded-lg w-fit text-left transition-colors group",
        "bg-[var(--surface-2)] border border-[var(--border)]",
        "hover:border-[var(--accent)]/50 hover:bg-[color-mix(in_srgb,var(--accent)_4%,var(--surface-2))]",
        !tc.ok && "border-[var(--danger)]/30 opacity-60 pointer-events-none",
      )}
    >
      {/* Type icon */}
      <div className={cn(
        "w-5 h-5 rounded flex items-center justify-center flex-shrink-0",
        isNote
          ? "bg-[color-mix(in_srgb,var(--accent)_12%,transparent)]"
          : "bg-[color-mix(in_srgb,var(--success,#22c55e)_12%,transparent)]",
      )}>
        {isNote
          ? <FileText size={10} className="text-[var(--accent)]" />
          : <SquareCheck size={10} className="text-[color-mix(in_srgb,var(--success,#22c55e)_90%,var(--text-primary))]" />
        }
      </div>

      {/* Text */}
      <div className="flex flex-col min-w-0">
        <span className="text-[0.643rem] text-[var(--text-tertiary)] leading-none mb-0.5">{actionLabel}</span>
        <span className="text-[0.714rem] font-medium text-[var(--text-primary)] truncate max-w-[200px] leading-none group-hover:text-[var(--accent)] transition-colors">
          {tc.cairnRef.title}
        </span>
      </div>

      {/* Status dot */}
      <CheckCircle size={9} className={cn("shrink-0 ml-auto", tc.ok ? "text-[var(--accent)]" : "text-[var(--danger)]")} />
    </button>
  );
}

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

function ToolChip({ tc, index: _index }: { tc: { callId?: string; name: string; label: string; running?: boolean; ok: boolean; output?: string; cairnRef?: { type: "note" | "task"; id: string; title: string } }; index: number }) {
  const [expanded, setExpanded] = useState(false);

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
    return <CairnRefChip tc={{ name: tc.name, ok: tc.ok, cairnRef: tc.cairnRef }} />;
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
            <SubagentMessageRow key={msg.id} msg={msg} />
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

function SubagentMessageRow({ msg }: { msg: PiAgentMessage }) {
  const hasTools = (msg.toolCalls?.length ?? 0) > 0;
  const hasContent = msg.content.length > 0;

  return (
    <div className="flex gap-1.5 items-start">
      <MessageAvatar role="bot" size="sm" />
      <div className="flex-1 min-w-0 flex flex-col gap-0.5">
        {hasTools && (
          <div className="flex flex-col gap-0.5">
            {msg.toolCalls!.map((tc, i) => (
              <ToolChip key={i} tc={tc} index={i} />
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

interface PiMessageBubbleProps {
  message: PiAgentMessage;
}

export function PiMessageBubble({ message }: PiMessageBubbleProps) {
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
            <p className="whitespace-pre-wrap break-words">{message.content}</p>
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

        {/* Tool call chips — expandable */}
        {hasTools && (
          <div className="flex flex-col gap-0.5">
            {message.toolCalls!.map((tc, i) => (
              <ToolChip key={i} tc={tc} index={i} />
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
      </div>
    </div>
  );
}
