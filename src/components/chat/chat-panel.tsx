"use client";

import React, { useState, useRef, useEffect, useMemo, useCallback } from "react";
import { X, Send, Square, Sparkles, PenSquare, History, Pencil } from "lucide-react";
import { cn, formatRelative } from "@/lib/utils";
import { useCairnStore } from "@/store";
import { MIN_CHAT_PANEL_WIDTH, MAX_CHAT_PANEL_WIDTH } from "@/store/slices/ui";
import { useShallow } from "zustand/react/shallow";
import { useChatStream } from "@/hooks/useChatStream";

import { Tooltip } from "@/components/ui/tooltip";
import { ChatMessageBubble } from "./chat-panel/ChatMessageBubble";
import { SuggestedPrompts } from "./chat-panel/SuggestedPrompts";
import { ToolCallIndicator } from "./chat-panel/ToolCallIndicator";
import { QuestionForm } from "./chat-panel/QuestionForm";

interface ChatPanelProps {
  prefill?: { text: string; autoSend?: boolean } | null;
  onPrefillConsumed?: () => void;
}

export function ChatPanel({ prefill, onPrefillConsumed }: ChatPanelProps = {}) {
  const {
    chatOpen, toggleChat,
    activeProjectId, activeWorkspaceId,
    projects, workspaces,
    addMessage,
    chatMessages, chatThreads, aiConfig,
    createNewThread, deleteThread, renameThread,
    chatPanelWidth, setChatPanelWidth,
  } = useCairnStore(useShallow((s) => ({
    chatOpen:          s.chatOpen,
    toggleChat:        s.toggleChat,
    activeProjectId:   s.activeProjectId,
    activeWorkspaceId: s.activeWorkspaceId,
    projects:          s.projects,
    workspaces:        s.workspaces,
    addMessage:        s.addMessage,
    chatMessages:      s.chatMessages,
    chatThreads:       s.chatThreads,
    aiConfig:          s.aiConfig,
    createNewThread:   s.createNewThread,
    deleteThread:      s.deleteThread,
    renameThread:      s.renameThread,
    chatPanelWidth:    s.chatPanelWidth,
    setChatPanelWidth: s.setChatPanelWidth,
  })));

  const [input, setInput]             = useState("");
  const [threadId, setThreadId]       = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [renamingThreadId, setRenamingThreadId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const historyRef     = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef       = useRef<HTMLTextAreaElement>(null);
  const panelRef       = useRef<HTMLElement>(null);
  const dividerRef     = useRef<HTMLDivElement>(null);

  const { isLoading, toolCalls, streamingContent, pendingQuestions, sendStream, stopStream } = useChatStream(threadId);

  // Track isLoading in a ref so the thread-init effect can read it without
  // being listed as a dependency (we never want a loading-state change to
  // re-trigger thread selection).
  const isLoadingRef = useRef(isLoading);
  useEffect(() => { isLoadingRef.current = isLoading; }, [isLoading]);

  const project   = useMemo(() => projects.find((p) => p.id === activeProjectId),   [projects, activeProjectId]);
  const workspace = useMemo(() => workspaces.find((w) => w.id === activeWorkspaceId), [workspaces, activeWorkspaceId]);

  const projectThreads = useMemo(
    () => chatThreads
      .filter((t) => t.projectId === activeProjectId)
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
      .slice(0, 15),
    [chatThreads, activeProjectId],
  );

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

  const messages = useMemo(
    () => threadId ? chatMessages.filter((m) => m.threadId === threadId) : [],
    [threadId, chatMessages],
  );

  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages, isLoading]);
  useEffect(() => { if (chatOpen) inputRef.current?.focus(); }, [chatOpen]);

  const handleSend = useCallback((text?: string) => {
    const content = text ?? input.trim();
    if (!content || !threadId) return;
    setInput("");
    addMessage(threadId, "user", content);
    sendStream({
      message: content, threadId,
      projectId: activeProjectId,
      workspaceId: activeWorkspaceId,
      history: messages.slice(-40).map((m) => ({ role: m.role, content: m.content })),
      config: {
        baseUrl:     aiConfig.baseUrl     || undefined,
        model:       aiConfig.model       || undefined,
        apiKey:      aiConfig.apiKey      || undefined,
        maxSteps:    aiConfig.maxSteps    ?? 20,
        temperature: aiConfig.temperature ?? 0.3,
      },
    });
  }, [input, threadId, addMessage, sendStream, activeProjectId, activeWorkspaceId, messages, aiConfig]);

  const shouldAutoSendRef = useRef(false);

  // Pre-fill input when opened via cairn:open-chat event
  useEffect(() => {
    if (prefill) {
      setInput(prefill.text);
      if (prefill.autoSend) {
        shouldAutoSendRef.current = true;
      }
      onPrefillConsumed?.();
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefill, onPrefillConsumed]);

  useEffect(() => {
    if (threadId && shouldAutoSendRef.current) {
      shouldAutoSendRef.current = false;
      const textToSend = input.trim() || prefill?.text;
      if (textToSend) {
        handleSend(textToSend);
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId, input, prefill, handleSend]);

  // ── Drag-to-resize ──────────────────────────────────────────────────────────
  // Mutates the panel DOM width directly on mousemove (no React state during
  // drag) for zero-lag resizing, then commits to the store on mouseup.
  useEffect(() => {
    const divider = dividerRef.current;
    const panel   = panelRef.current;
    if (!divider || !panel) return;

    let dragging = false;
    let startX   = 0;
    let startW   = 0;

    function onMouseMove(e: MouseEvent) {
      if (!dragging) return;
      // Panel is on the right; dragging left (lower clientX) makes it wider.
      const next = Math.min(MAX_CHAT_PANEL_WIDTH, Math.max(MIN_CHAT_PANEL_WIDTH, startW - (e.clientX - startX)));
      panel!.style.width = `${next}px`;
    }

    function onMouseUp() {
      if (!dragging) return;
      dragging = false;
      document.body.style.cursor     = "";
      document.body.style.userSelect = "";
      // Persist final width to store (and localStorage)
      const finalWidth = panel!.offsetWidth;
      setChatPanelWidth(finalWidth);
    }

    function onMouseDown(e: MouseEvent) {
      dragging = true;
      startX   = e.clientX;
      startW   = panel!.offsetWidth;
      document.body.style.cursor     = "col-resize";
      document.body.style.userSelect = "none";
      e.preventDefault();
    }

    divider.addEventListener("mousedown", onMouseDown);
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup",   onMouseUp);

    return () => {
      divider.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup",   onMouseUp);
    };
  // setChatPanelWidth is stable (Zustand action), so omitting from deps is safe.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleNewThread = useCallback(() => {
    if (!activeWorkspaceId) return;
    setThreadId(createNewThread(activeWorkspaceId, activeProjectId ?? undefined).id);
  }, [activeWorkspaceId, activeProjectId, createNewThread]);



  if (!chatOpen) return null;

  return (
    <aside
      ref={panelRef}
      className="flex flex-col border-l border-[var(--border)] bg-[var(--surface)] flex-shrink-0 animate-slide-in-right relative"
      style={{ width: chatPanelWidth }}
    >
      {/* Drag-to-resize handle — sits on the left edge of the panel */}
      <div
        ref={dividerRef}
        className="absolute left-0 top-0 h-full w-0 flex-shrink-0 cursor-col-resize z-10 select-none"
        style={{ marginLeft: -3, padding: "0 3px" }}
        aria-hidden
      />
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
          <button onClick={handleNewThread}
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
        {pendingQuestions && (
          <QuestionForm
            questions={pendingQuestions}
            onSubmit={(text) => handleSend(text)}
            disabled={isLoading && !pendingQuestions}
          />
        )}
        {isLoading && <ToolCallIndicator toolCalls={toolCalls} streamingContent={streamingContent} />}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="border-t border-[var(--border)] p-3 flex-shrink-0">
        <div className="relative">
          <textarea ref={inputRef} value={input} onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
            placeholder="Ask about your project…" rows={2}
            className="w-full resize-none rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2.5 pr-10 text-xs text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus:outline-none focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent-dim)] transition-colors leading-relaxed" />
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
