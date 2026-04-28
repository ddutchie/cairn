"use client";

import React, { useState, useRef, useEffect } from "react";
import {
  X,
  Send,
  Bot,
  User,
  FileText,
  Kanban,
  FolderOpen,
  Loader2,
  CheckCircle,
  XCircle,
  AlertCircle,
  Sparkles,
  ChevronDown,
} from "lucide-react";
import { cn, formatRelative } from "@/lib/utils";
import { useCairnStore } from "@/store";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import type { ChatMessage, LinkedContextReference, PendingAction } from "@/types";

const SUGGESTED_PROMPTS = [
  "Summarize this project",
  "What tasks are in progress?",
  "Create tasks from recent notes",
  "What are the blocked items?",
  "Draft a project brief",
];

export function ChatPanel() {
  const {
    chatOpen,
    toggleChat,
    activeProjectId,
    activeWorkspaceId,
    projects,
    workspaces,
    notes,
    columns,
    cards,
    tags,
    getOrCreateThread,
    addMessage,
    updateNote,
    updateCard,
    moveCard,
    createNote,
    createCard,
    chatMessages,
    confirmAction,
    aiConfig,
    setView,
  } = useCairnStore();

  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [toolCalls, setToolCalls] = useState<Array<{ tool: string; label: string }>>([]);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const project = projects.find((p) => p.id === activeProjectId);
  const workspace = workspaces.find((w) => w.id === activeWorkspaceId);

  // getOrCreateThread calls set() — must never be called during render
  useEffect(() => {
    if (!activeWorkspaceId) return;
    const t = getOrCreateThread(activeWorkspaceId, activeProjectId ?? undefined);
    setThreadId(t.id);
  }, [activeWorkspaceId, activeProjectId, getOrCreateThread]);

  // Subscribe to live tool call events from the main process
  useEffect(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const electron = (window as any).electron;
    if (!electron?.onToolCall) return;
    const unsub = electron.onToolCall((e: { tool: string; label: string }) => {
      setToolCalls((prev) => [...prev, e]);
    });
    return unsub;
  }, []);

  const messages = threadId
    ? chatMessages.filter((m) => m.threadId === threadId)
    : [];

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isLoading]);

  useEffect(() => {
    if (chatOpen) inputRef.current?.focus();
  }, [chatOpen]);

  async function handleSend(text?: string) {
    const content = text ?? input.trim();
    if (!content || !threadId) return;

    setInput("");
    addMessage(threadId, "user", content);
    setIsLoading(true);
    setToolCalls([]);

    // Build a store snapshot to send to the API so tools have real data
    const snapshot = {
      workspaces,
      projects,
      notes,
      columns,
      cards,
      tags,
    };

    const chatReq = {
      message: content,
      threadId,
      projectId: activeProjectId,
      workspaceId: activeWorkspaceId,
      history: messages.slice(-10).map((m) => ({ role: m.role, content: m.content })),
      snapshot,
      config: {
        baseUrl: aiConfig.baseUrl || undefined,
        model: aiConfig.model || undefined,
        apiKey: aiConfig.apiKey || undefined,
      },
    };

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const data = await (window as any).electron.chatSend(chatReq);
      addMessage(threadId, "assistant", data.content, data.contextRefs);
      // UI updates happen automatically via the db:changed watcher → hydrateFromElectron(true)
    } catch (err) {
      addMessage(
        threadId,
        "assistant",
        err instanceof Error && err.message.includes("fetch")
          ? "Could not reach the server. Is the app running?"
          : "Something went wrong. Check your AI settings or try again."
      );
    } finally {
      setIsLoading(false);
      setToolCalls([]);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  if (!chatOpen) return null;

  return (
    <aside className="flex flex-col w-80 border-l border-[var(--border)] bg-[var(--surface)] flex-shrink-0 animate-slide-in-right">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 h-11 border-b border-[var(--border)] flex-shrink-0">
        <Sparkles size={13} className="text-[var(--accent)]" />
        <span className="text-sm font-semibold text-[var(--text-primary)] flex-1">
          AI Assistant
        </span>
        <span className="text-xs text-[var(--text-tertiary)] truncate max-w-24">
          {project?.name ?? workspace?.name}
        </span>
        <Tooltip content="Close chat" side="left">
          <button
            onClick={toggleChat}
            className="p-1 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)] transition-colors"
          >
            <X size={13} />
          </button>
        </Tooltip>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-3 py-3 space-y-3 min-h-0">
        {messages.length === 0 ? (
          <div className="space-y-4">
            <div className="text-center pt-4">
              <div className="w-10 h-10 rounded-xl bg-[var(--accent-dim)] flex items-center justify-center mx-auto mb-3">
                <Sparkles size={18} className="text-[var(--accent)]" />
              </div>
              <p className="text-sm font-medium text-[var(--text-primary)]">
                Cairn AI
              </p>
              <p className="text-xs text-[var(--text-tertiary)] mt-1 max-w-52 mx-auto">
                Ask me about your project, notes, or tasks. I can read and write with your permission.
              </p>
            </div>

            {/* Suggested prompts */}
            <div className="space-y-1.5">
              {SUGGESTED_PROMPTS.map((prompt) => (
                <button
                  key={prompt}
                  onClick={() => handleSend(prompt)}
                  className="w-full text-left px-3 py-2.5 rounded-lg border border-[var(--border)] text-xs text-[var(--text-secondary)] hover:border-[var(--accent)]/40 hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)] transition-all"
                >
                  {prompt}
                </button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((message) => (
            <ChatMessageItem
              key={message.id}
              message={message}
              onConfirmAction={(action) => {
                confirmAction(action);
              }}
            />
          ))
        )}

        {isLoading && (
          <div className="flex gap-2 items-start">
            <div className="w-6 h-6 rounded-full bg-[var(--accent-dim)] flex items-center justify-center flex-shrink-0 mt-0.5 shrink-0">
              <Bot size={11} className="text-[var(--accent)]" />
            </div>
            <div className="flex flex-col gap-1 min-w-0">
              {toolCalls.map((tc, i) => (
                <div key={i} className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-[var(--surface-2)] border border-[var(--border)] w-fit">
                  <CheckCircle size={10} className="text-[var(--accent)] shrink-0" />
                  <span className="text-[11px] text-[var(--text-secondary)]">{tc.label}</span>
                </div>
              ))}
              <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-[var(--surface-2)] border border-[var(--border)] w-fit">
                <Loader2 size={10} className="text-[var(--accent)] animate-spin shrink-0" />
                <span className="text-[11px] text-[var(--text-tertiary)]">
                  {toolCalls.length === 0 ? "Thinking…" : "Working…"}
                </span>
              </div>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="border-t border-[var(--border)] p-3 flex-shrink-0">
        <div className="relative">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask about your project…"
            rows={2}
            className="w-full resize-none rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2.5 pr-10 text-xs text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus:outline-none focus:border-[var(--accent)] transition-colors leading-relaxed"
          />
          <Tooltip content="Send (Enter)" side="left">
            <button
              onClick={() => handleSend()}
              disabled={!input.trim() || isLoading}
              className="absolute right-2 bottom-2 p-1.5 rounded-md text-[var(--accent)] hover:bg-[var(--accent-dim)] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Send size={13} />
            </button>
          </Tooltip>
        </div>
        <p className="text-[10px] text-[var(--text-tertiary)] mt-1.5 text-center">
          Shift+Enter for new line · Enter to send
        </p>
      </div>
    </aside>
  );
}

function ChatMessageItem({
  message,
  onConfirmAction,
}: {
  message: ChatMessage;
  onConfirmAction: (action: PendingAction) => void;
}) {
  const isUser = message.role === "user";

  return (
    <div className={cn("flex gap-2 items-start", isUser && "flex-row-reverse")}>
      {/* Avatar */}
      <div
        className={cn(
          "w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5",
          isUser
            ? "bg-[var(--surface-3)] border border-[var(--border)]"
            : "bg-[var(--accent-dim)] border border-[var(--accent)]/20"
        )}
      >
        {isUser ? (
          <User size={11} className="text-[var(--text-tertiary)]" />
        ) : (
          <Bot size={11} className="text-[var(--accent)]" />
        )}
      </div>

      <div className={cn("flex-1 min-w-0 space-y-1.5", isUser && "items-end flex flex-col")}>
        {/* Bubble */}
        <div
          className={cn(
            "px-3 py-2.5 rounded-xl text-xs leading-relaxed max-w-full",
            isUser
              ? "bg-[var(--accent)] text-white rounded-tr-sm"
              : "bg-[var(--surface-2)] border border-[var(--border)] text-[var(--text-secondary)] rounded-tl-sm"
          )}
        >
          <MarkdownContent content={message.content} />
        </div>

        {/* Context refs */}
        {message.contextRefs && message.contextRefs.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {message.contextRefs.map((ref, i) => (
              <ContextRefChip key={i} ref_={ref} />
            ))}
          </div>
        )}

        {/* Pending action */}
        {message.pendingAction && (
          <PendingActionCard
            action={message.pendingAction}
            onConfirm={() => onConfirmAction(message.pendingAction!)}
          />
        )}

        <span className="text-[10px] text-[var(--text-tertiary)]">
          {formatRelative(message.createdAt)}
        </span>
      </div>
    </div>
  );
}

function ContextRefChip({ ref_ }: { ref_: LinkedContextReference }) {
  const icons = {
    note: <FileText size={9} />,
    task: <Kanban size={9} />,
    project: <FolderOpen size={9} />,
    search_result: <Kanban size={9} />,
  };

  return (
    <span className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-[var(--surface-3)] border border-[var(--border)] text-[10px] text-[var(--text-tertiary)]">
      {icons[ref_.type]}
      {ref_.title}
    </span>
  );
}

function PendingActionCard({
  action,
  onConfirm,
}: {
  action: PendingAction;
  onConfirm: () => void;
}) {
  const [status, setStatus] = useState<"pending" | "confirmed" | "rejected">("pending");

  const actionLabels: Record<string, string> = {
    create_note: "Create note",
    create_task: "Create task",
    update_task_status: "Move task",
    update_note: "Update note",
    link_note_to_task: "Link note to task",
    move_task: "Move task",
  };

  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2.5 space-y-2 w-full">
      <div className="flex items-center gap-1.5">
        <AlertCircle size={11} className="text-[var(--warning)]" />
        <span className="text-xs font-medium text-[var(--text-secondary)]">
          Action requested: {actionLabels[action.type] ?? action.type}
        </span>
      </div>

      {status === "pending" && (
        <div className="flex gap-1.5">
          <Button
            variant="accent"
            size="xs"
            onClick={() => {
              onConfirm();
              setStatus("confirmed");
            }}
          >
            <CheckCircle size={10} />
            Confirm
          </Button>
          <Button
            variant="ghost"
            size="xs"
            onClick={() => setStatus("rejected")}
          >
            <XCircle size={10} />
            Reject
          </Button>
        </div>
      )}

      {status === "confirmed" && (
        <span className="text-[11px] text-[var(--success)] flex items-center gap-1">
          <CheckCircle size={10} /> Done
        </span>
      )}
      {status === "rejected" && (
        <span className="text-[11px] text-red-400 flex items-center gap-1">
          <XCircle size={10} /> Rejected
        </span>
      )}
    </div>
  );
}

/** Very simple markdown renderer for chat messages */
function MarkdownContent({ content }: { content: string }) {
  const lines = content.split("\n");
  return (
    <>
      {lines.map((line, i) => {
        if (line.startsWith("**") && line.endsWith("**")) {
          return (
            <div key={i} className="font-semibold text-[var(--text-primary)] mt-1">
              {line.slice(2, -2)}
            </div>
          );
        }
        if (line.startsWith("- ") || line.startsWith("* ")) {
          return (
            <div key={i} className="flex gap-1.5 mt-0.5">
              <span className="opacity-50 flex-shrink-0">•</span>
              <span>{renderInline(line.slice(2))}</span>
            </div>
          );
        }
        if (line === "") return <div key={i} className="h-2" />;
        return <div key={i}>{renderInline(line)}</div>;
      })}
    </>
  );
}

function renderInline(text: string): React.ReactNode {
  // Simple bold (**text**) and italic (_text_) rendering
  const parts = text.split(/(\*\*[^*]+\*\*|_[^_]+_)/g);
  return parts.map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      return <strong key={i} className="font-semibold text-inherit">{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith("_") && part.endsWith("_")) {
      return <em key={i} className="italic opacity-80">{part.slice(1, -1)}</em>;
    }
    return part;
  });
}
