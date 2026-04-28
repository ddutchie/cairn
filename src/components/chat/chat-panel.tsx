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
  PenSquare,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
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
    getOrCreateThread,
    addMessage,
    chatMessages,
    confirmAction,
    aiConfig,
    setView,
    createNewThread,
  } = useCairnStore();

  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [toolCalls, setToolCalls] = useState<Array<{ tool: string; label: string }>>([]);
  // Live token buffer — shown as a streaming bubble while the model is typing
  const [streamingContent, setStreamingContent] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // Keep a stable ref to the current threadId so event handlers don't go stale
  const threadIdRef = useRef<string | null>(null);
  useEffect(() => { threadIdRef.current = threadId; }, [threadId]);

  const project = projects.find((p) => p.id === activeProjectId);
  const workspace = workspaces.find((w) => w.id === activeWorkspaceId);

  // getOrCreateThread calls set() — must never be called during render
  useEffect(() => {
    if (!activeWorkspaceId) return;
    const t = getOrCreateThread(activeWorkspaceId, activeProjectId ?? undefined);
    setThreadId(t.id);
  }, [activeWorkspaceId, activeProjectId, getOrCreateThread]);

  // Subscribe to streaming events from the main process
  useEffect(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const electron = (window as any).electron;
    if (!electron) return;

    const unsubTool = electron.onToolCall?.((e: { tool: string; label: string }) => {
      setToolCalls((prev) => [...prev, e]);
    });

    const unsubToken = electron.onChatToken?.((e: { delta: string }) => {
      setStreamingContent((prev) => prev + e.delta);
    });

    const unsubDone = electron.onChatDone?.((e: { content: string; contextRefs: unknown[] }) => {
      const tid = threadIdRef.current;
      if (tid) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        addMessage(tid, "assistant", e.content, e.contextRefs as any);
      }
      setStreamingContent("");
      setIsLoading(false);
      setToolCalls([]);
    });

    return () => {
      unsubTool?.();
      unsubToken?.();
      unsubDone?.();
    };
  // addMessage is stable (from zustand), intentionally omitted from deps
  // eslint-disable-next-line react-hooks/exhaustive-deps
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

  function handleSend(text?: string) {
    const content = text ?? input.trim();
    if (!content || !threadId) return;

    setInput("");
    addMessage(threadId, "user", content);
    setIsLoading(true);
    setToolCalls([]);

    const chatReq = {
      message: content,
      threadId,
      projectId: activeProjectId,
      workspaceId: activeWorkspaceId,
      // slice(-9) leaves room for the new user message the backend appends from req.message
      history: messages.slice(-9).map((m) => ({ role: m.role, content: m.content })),
      config: {
        baseUrl: aiConfig.baseUrl || undefined,
        model: aiConfig.model || undefined,
        apiKey: aiConfig.apiKey || undefined,
      },
    };

    // Fire-and-forget — response arrives via chat:token / chat:done events.
    window.electron?.chatStream(chatReq);
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
        <Tooltip content="New chat" side="left">
          <button
            onClick={() => {
              if (!activeWorkspaceId) return;
              const t = createNewThread(activeWorkspaceId, activeProjectId ?? undefined);
              setThreadId(t.id);
            }}
            className="p-1 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)] transition-colors"
          >
            <PenSquare size={13} />
          </button>
        </Tooltip>
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
                  disabled={isLoading || !threadId}
                  className="w-full text-left px-3 py-2.5 rounded-lg border border-[var(--border)] text-xs text-[var(--text-secondary)] hover:border-[var(--accent)]/40 hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)] transition-all disabled:opacity-40 disabled:pointer-events-none"
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
            <div className="flex flex-col gap-1 min-w-0 flex-1">
              {/* Tool call badges */}
              {toolCalls.map((tc, i) => (
                <div key={i} className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-[var(--surface-2)] border border-[var(--border)] w-fit">
                  <CheckCircle size={10} className="text-[var(--accent)] shrink-0" />
                  <span className="text-[11px] text-[var(--text-secondary)]">{tc.label}</span>
                </div>
              ))}

              {/* Live streaming bubble — shown once tokens arrive */}
              {streamingContent ? (
                <div className="px-3 py-2.5 rounded-xl rounded-tl-sm text-xs leading-relaxed bg-[var(--surface-2)] border border-[var(--border)] text-[var(--text-secondary)] max-w-full">
                  <MarkdownContent content={streamingContent} />
                  <span className="inline-block w-0.5 h-3 bg-[var(--accent)] animate-pulse ml-0.5 align-middle" />
                </div>
              ) : (
                <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-[var(--surface-2)] border border-[var(--border)] w-fit">
                  <Loader2 size={10} className="text-[var(--accent)] animate-spin shrink-0" />
                  <span className="text-[11px] text-[var(--text-tertiary)]">
                    {toolCalls.length === 0 ? "Thinking…" : "Working…"}
                  </span>
                </div>
              )}
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
          {isUser
            ? <span className="whitespace-pre-wrap">{message.content}</span>
            : <MarkdownContent content={message.content} />
          }
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

/** Markdown renderer for assistant chat messages */
function MarkdownContent({ content }: { content: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        p: ({ children }) => <p className="mb-1.5 last:mb-0 leading-relaxed">{children}</p>,
        strong: ({ children }) => <strong className="font-semibold text-[var(--text-primary)]">{children}</strong>,
        em: ({ children }) => <em className="italic opacity-80">{children}</em>,
        ul: ({ children }) => <ul className="my-1.5 pl-4 list-disc space-y-0.5 text-[var(--text-secondary)]">{children}</ul>,
        ol: ({ children }) => <ol className="my-1.5 pl-4 list-decimal space-y-0.5 text-[var(--text-secondary)]">{children}</ol>,
        li: ({ children }) => <li className="leading-relaxed">{children}</li>,
        h1: ({ children }) => <h1 className="font-semibold text-[var(--text-primary)] text-sm mt-2 mb-1">{children}</h1>,
        h2: ({ children }) => <h2 className="font-semibold text-[var(--text-primary)] text-sm mt-2 mb-1">{children}</h2>,
        h3: ({ children }) => <h3 className="font-medium text-[var(--text-primary)] mt-1.5 mb-0.5">{children}</h3>,
        code: ({ children, className }) => {
          const isBlock = className?.includes("language-");
          return isBlock ? (
            <code className="block my-1.5 px-3 py-2 rounded-md bg-[var(--surface-3)] border border-[var(--border)] font-mono text-[11px] text-[var(--text-primary)] overflow-x-auto whitespace-pre">
              {children}
            </code>
          ) : (
            <code className="px-1 py-0.5 rounded bg-[var(--surface-3)] font-mono text-[11px] text-[var(--text-primary)]">
              {children}
            </code>
          );
        },
        pre: ({ children }) => <>{children}</>,
        blockquote: ({ children }) => (
          <blockquote className="border-l-2 border-[var(--accent)] pl-2.5 my-1.5 text-[var(--text-tertiary)] italic">
            {children}
          </blockquote>
        ),
        a: ({ href, children }) => (
          <a href={href} className="text-[var(--accent)] hover:underline" target="_blank" rel="noreferrer">
            {children}
          </a>
        ),
        hr: () => <hr className="my-2 border-[var(--border)]" />,
        table: ({ children }) => (
          <div className="my-2 overflow-x-auto">
            <table className="w-full border-collapse text-xs">{children}</table>
          </div>
        ),
        thead: ({ children }) => <thead>{children}</thead>,
        tbody: ({ children }) => <tbody>{children}</tbody>,
        tr: ({ children }) => <tr className="border-b border-[var(--border)]">{children}</tr>,
        th: ({ children }) => (
          <th className="px-2.5 py-1.5 text-left font-semibold text-[var(--text-primary)] bg-[var(--surface-2)] border border-[var(--border)]">
            {children}
          </th>
        ),
        td: ({ children }) => (
          <td className="px-2.5 py-1.5 text-[var(--text-secondary)] border border-[var(--border)]">
            {children}
          </td>
        ),
      }}
    >
      {content}
    </ReactMarkdown>
  );
}
