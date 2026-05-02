"use client";

import React, { useState, useRef, useEffect } from "react";
import { X, Send, Square, Sparkles, PenSquare, History, Check, Pencil } from "lucide-react";
import { cn, formatRelative } from "@/lib/utils";
import { useCairnStore } from "@/store";
import { useChatStream } from "@/hooks/useChatStream";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { ChatMessageBubble } from "./chat-panel/ChatMessageBubble";
import { SuggestedPrompts } from "./chat-panel/SuggestedPrompts";
import { ToolCallIndicator } from "./chat-panel/ToolCallIndicator";

interface ChatPanelProps {
  prefill?: string | null;
  onPrefillConsumed?: () => void;
}

export function ChatPanel({ prefill, onPrefillConsumed }: ChatPanelProps = {}) {
  const {
    chatOpen, toggleChat,
    activeProjectId, activeWorkspaceId,
    projects, workspaces,
    addMessage,
    chatMessages, chatThreads, aiConfig,
    setView, createNewThread, deleteThread, renameThread,
  } = useCairnStore();

  const [input, setInput]             = useState("");
  const [threadId, setThreadId]       = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [renamingThreadId, setRenamingThreadId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const historyRef     = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef       = useRef<HTMLTextAreaElement>(null);

  const { isLoading, toolCalls, streamingContent, sendStream, stopStream } = useChatStream(threadId);

  // Track isLoading in a ref so the thread-init effect can read it without
  // being listed as a dependency (we never want a loading-state change to
  // re-trigger thread selection).
  const isLoadingRef = useRef(isLoading);
  useEffect(() => { isLoadingRef.current = isLoading; }, [isLoading]);

  const project   = projects.find((p) => p.id === activeProjectId);
  const workspace = workspaces.find((w) => w.id === activeWorkspaceId);

  const projectThreads = chatThreads
    .filter((t) => t.projectId === activeProjectId)
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .slice(0, 15);

  // Initialise / switch thread.
  // Reads getOrCreateThread directly from the store snapshot (stable, no ref
  // needed) so the effect only re-runs when the workspace/project identity
  // changes. Never switches while a stream is in-flight.
  useEffect(() => {
    if (!activeWorkspaceId) return;
    if (isLoadingRef.current) return;
    const t = useCairnStore.getState().getOrCreateThread(activeWorkspaceId, activeProjectId ?? undefined);
    setThreadId(t.id);
  }, [activeWorkspaceId, activeProjectId]);

  // Close history on outside click
  useEffect(() => {
    if (!historyOpen) return;
    function handle(e: MouseEvent) {
      if (historyRef.current && !historyRef.current.contains(e.target as Node)) setHistoryOpen(false);
    }
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [historyOpen]);

  const messages = threadId ? chatMessages.filter((m) => m.threadId === threadId) : [];

  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages, isLoading]);
  useEffect(() => { if (chatOpen) inputRef.current?.focus(); }, [chatOpen]);

  // Pre-fill input when opened via cairn:open-chat event
  useEffect(() => {
    if (prefill) {
      setInput(prefill);
      onPrefillConsumed?.();
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefill]);

  function handleSend(text?: string) {
    const content = text ?? input.trim();
    if (!content || !threadId) return;
    setInput("");
    addMessage(threadId, "user", content);
    sendStream({
      message: content, threadId,
      projectId: activeProjectId,
      workspaceId: activeWorkspaceId,
      history: messages.slice(-9).map((m) => ({ role: m.role, content: m.content })),
      config: {
        baseUrl: aiConfig.baseUrl || undefined,
        model: aiConfig.model || undefined,
        apiKey: aiConfig.apiKey || undefined,
      },
    });
  }

  if (!chatOpen) return null;

  return (
    <aside className="flex flex-col w-80 border-l border-[var(--border)] bg-[var(--surface)] flex-shrink-0 animate-slide-in-right">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 h-11 border-b border-[var(--border)] flex-shrink-0">
        <Sparkles size={13} className="text-[var(--accent)]" />
        <span className="text-sm font-semibold text-[var(--text-primary)] flex-1">AI Assistant</span>
        <span className="text-xs text-[var(--text-tertiary)] truncate max-w-24">{project?.name ?? workspace?.name}</span>

        {/* Thread history */}
        {projectThreads.length > 1 && (
          <div ref={historyRef} className="relative">
            <Tooltip content="Thread history" side="left">
              <button onClick={() => setHistoryOpen((o) => !o)}
                className={cn("p-1 rounded transition-colors",
                  historyOpen ? "text-[var(--accent)] bg-[var(--accent-dim)]" : "text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)]")}>
                <History size={13} />
              </button>
            </Tooltip>
            {historyOpen && (
              <div className="absolute right-0 top-full mt-1 w-64 z-50 bg-[var(--surface)] border border-[var(--border)] rounded-xl shadow-2xl overflow-hidden">
                <div className="px-3 py-2 border-b border-[var(--border)]">
                  <span className="text-[0.714rem] font-semibold uppercase tracking-wider text-[var(--text-tertiary)]">Recent threads</span>
                </div>
                <div className="max-h-72 overflow-y-auto">
                  {projectThreads.map((t) => {
                    const firstMsg = chatMessages.find((m) => m.threadId === t.id && m.role === "user");
                    const isActive = t.id === threadId;
                    return (
                      <div key={t.id}
                        className={cn("group flex items-center border-b border-[var(--border-subtle)] last:border-0 transition-colors",
                          isActive ? "bg-[var(--accent-dim)]" : "hover:bg-[var(--surface-2)]")}>
                        <button onClick={() => { setThreadId(t.id); setHistoryOpen(false); }}
                          className="flex-1 text-left px-3 py-2.5 flex flex-col gap-0.5 min-w-0">
                          {renamingThreadId === t.id ? (
                            <input
                              autoFocus
                              value={renameValue}
                              onChange={(e) => setRenameValue(e.target.value)}
                              onClick={(e) => e.stopPropagation()}
                              onBlur={() => { renameThread(t.id, renameValue); setRenamingThreadId(null); }}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") { renameThread(t.id, renameValue); setRenamingThreadId(null); }
                                if (e.key === "Escape") setRenamingThreadId(null);
                                e.stopPropagation();
                              }}
                              className="w-full bg-transparent text-[0.786rem] font-medium text-[var(--accent)] outline-none border-b border-[var(--accent)]"
                            />
                          ) : (
                            <span className={cn("text-[0.786rem] truncate font-medium", isActive ? "text-[var(--accent)]" : "text-[var(--text-secondary)]")}>
                              {t.title ?? (firstMsg?.content.slice(0, 50) ?? "New thread")}{(!t.title && (firstMsg?.content.length ?? 0) > 50) ? "…" : ""}
                            </span>
                          )}
                          <span className="text-[0.714rem] text-[var(--text-tertiary)]">{formatRelative(t.updatedAt)}</span>
                        </button>
                        <div className="opacity-0 group-hover:opacity-100 flex items-center flex-shrink-0 mr-1 transition-all">
                          <button onClick={(e) => { e.stopPropagation(); setRenamingThreadId(t.id); setRenameValue(t.title ?? firstMsg?.content.slice(0, 50) ?? ""); }}
                            className="p-1.5 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)] transition-colors"
                            title="Rename thread">
                            <Pencil size={10} />
                          </button>
                          <button onClick={(e) => {
                              e.stopPropagation();
                              deleteThread(t.id);
                              if (isActive && activeWorkspaceId) {
                                const next = createNewThread(activeWorkspaceId, activeProjectId ?? undefined);
                                setThreadId(next.id);
                                setHistoryOpen(false);
                              }
                            }}
                            className="p-1.5 rounded text-[var(--text-tertiary)] hover:text-[var(--danger)] transition-colors"
                            title="Delete thread">
                            <X size={10} />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}

        <Tooltip content="New chat" side="left">
          <button onClick={() => {
              if (!activeWorkspaceId) return;
              setThreadId(createNewThread(activeWorkspaceId, activeProjectId ?? undefined).id);
            }}
            className="p-1 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)] transition-colors">
            <PenSquare size={13} />
          </button>
        </Tooltip>
        <Tooltip content="Close chat" side="left">
          <button onClick={toggleChat} className="p-1 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)] transition-colors">
            <X size={13} />
          </button>
        </Tooltip>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-3 py-3 space-y-3 min-h-0">
        {messages.length === 0
          ? <SuggestedPrompts onSend={handleSend} disabled={isLoading || !threadId} />
          : messages.map((message) => (
              <ChatMessageBubble
                key={message.id}
                message={message}
                onRetry={!isLoading ? (content) => handleSend(content) : undefined}
              />
            ))
        }
        {isLoading && <ToolCallIndicator toolCalls={toolCalls} streamingContent={streamingContent} />}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="border-t border-[var(--border)] p-3 flex-shrink-0">
        <div className="relative">
          <textarea ref={inputRef} value={input} onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
            placeholder="Ask about your project…" rows={2}
            className="w-full resize-none rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2.5 pr-10 text-xs text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus:outline-none focus:border-[var(--accent)] transition-colors leading-relaxed" />
          {isLoading ? (
            <Tooltip content="Stop generation" side="left">
              <button onClick={stopStream}
                className="absolute right-2 bottom-2 p-1.5 rounded-md text-[var(--danger)] hover:bg-[var(--danger)]/10 transition-colors">
                <Square size={13} />
              </button>
            </Tooltip>
          ) : (
            <Tooltip content="Send (Enter)" side="left">
              <button onClick={() => handleSend()} disabled={!input.trim()}
                className="absolute right-2 bottom-2 p-1.5 rounded-md text-[var(--accent)] hover:bg-[var(--accent-dim)] transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
                <Send size={13} />
              </button>
            </Tooltip>
          )}
        </div>
        <p className="text-[0.714rem] text-[var(--text-tertiary)] mt-1.5 text-center">
          {isLoading ? "Generating… click ◼ to stop" : "Shift+Enter for new line · Enter to send"}
        </p>
      </div>
    </aside>
  );
}
