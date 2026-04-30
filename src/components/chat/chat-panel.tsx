"use client";

import React, { useState, useRef, useEffect } from "react";
import { X, Send, Sparkles, PenSquare, History } from "lucide-react";
import { cn, formatRelative } from "@/lib/utils";
import { useCairnStore } from "@/store";
import { useChatStream } from "@/hooks/useChatStream";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { ChatMessageBubble } from "./chat-panel/ChatMessageBubble";
import { SuggestedPrompts } from "./chat-panel/SuggestedPrompts";
import { ToolCallIndicator } from "./chat-panel/ToolCallIndicator";

export function ChatPanel() {
  const {
    chatOpen, toggleChat,
    activeProjectId, activeWorkspaceId,
    projects, workspaces,
    getOrCreateThread, addMessage,
    chatMessages, chatThreads, aiConfig,
    setView, createNewThread, deleteThread,
  } = useCairnStore();

  const [input, setInput]           = useState("");
  const [threadId, setThreadId]     = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const historyRef     = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef       = useRef<HTMLTextAreaElement>(null);

  const { isLoading, toolCalls, streamingContent, sendStream } = useChatStream(threadId);

  const project   = projects.find((p) => p.id === activeProjectId);
  const workspace = workspaces.find((w) => w.id === activeWorkspaceId);

  const projectThreads = chatThreads
    .filter((t) => t.projectId === activeProjectId)
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .slice(0, 15);

  // Initialise thread
  useEffect(() => {
    if (!activeWorkspaceId) return;
    const t = getOrCreateThread(activeWorkspaceId, activeProjectId ?? undefined);
    setThreadId(t.id);
  }, [activeWorkspaceId, activeProjectId, getOrCreateThread]);

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
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)]">Recent threads</span>
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
                          <span className={cn("text-[11px] truncate font-medium", isActive ? "text-[var(--accent)]" : "text-[var(--text-secondary)]")}>
                            {firstMsg?.content.slice(0, 50) ?? "New thread"}{(firstMsg?.content.length ?? 0) > 50 ? "…" : ""}
                          </span>
                          <span className="text-[10px] text-[var(--text-tertiary)]">{formatRelative(t.updatedAt)}</span>
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
                          className="opacity-0 group-hover:opacity-100 flex-shrink-0 p-2 mr-1 rounded text-[var(--text-tertiary)] hover:text-[var(--danger)] transition-all"
                          title="Delete thread">
                          <X size={11} />
                        </button>
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
          : messages.map((message) => <ChatMessageBubble key={message.id} message={message} />)
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
          <Tooltip content="Send (Enter)" side="left">
            <button onClick={() => handleSend()} disabled={!input.trim() || isLoading}
              className="absolute right-2 bottom-2 p-1.5 rounded-md text-[var(--accent)] hover:bg-[var(--accent-dim)] transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
              <Send size={13} />
            </button>
          </Tooltip>
        </div>
        <p className="text-[10px] text-[var(--text-tertiary)] mt-1.5 text-center">Shift+Enter for new line · Enter to send</p>
      </div>
    </aside>
  );
}
