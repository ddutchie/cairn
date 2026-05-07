"use client";

/**
 * PiAgentPane — chat UI for Cairn native agent sessions.
 *
 * Rendered inside AgentTerminalPane when session.sessionType === "pi".
 * Subscribes to pi-agent:* IPC events and updates Zustand store.
 * Multi-turn: each new message continues the same session's history.
 */

import { useEffect, useRef, useState, useCallback } from "react";
import { Send, Square, RotateCcw, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { useCairnStore } from "@/store";
import { useShallow } from "zustand/react/shallow";
import { id } from "@/lib/utils";
import { PiMessageBubble } from "./PiMessageBubble";
import { Tooltip } from "@/components/ui/tooltip";
import type { TerminalSession } from "@/store/slices/terminal-sessions";

interface PiAgentPaneProps {
  session: TerminalSession;
  isActive: boolean;
}

export function PiAgentPane({ session, isActive }: PiAgentPaneProps) {
  const {
    addPiMessage,
    appendPiToken,
    finalisePiMessage,
    addPiToolCall,
    clearPiMessages,
    aiConfig,
    projects,
    activeWorkspaceId,
  } = useCairnStore(useShallow((s) => ({
    addPiMessage:      s.addPiMessage,
    appendPiToken:     s.appendPiToken,
    finalisePiMessage: s.finalisePiMessage,
    addPiToolCall:     s.addPiToolCall,
    clearPiMessages:   s.clearPiMessages,
    aiConfig:          s.aiConfig,
    projects:          s.projects,
    activeWorkspaceId: s.activeWorkspaceId,
  })));

  const messages    = session.piMessages ?? [];
  const project     = projects.find((p) => p.id === session.projectId);

  const [input, setInput]         = useState("");
  const [isLoading, setIsLoading] = useState(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef    = useRef<HTMLTextAreaElement>(null);

  // Scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length, messages[messages.length - 1]?.content?.length]);

  // Focus input when pane becomes active
  useEffect(() => {
    if (isActive) textareaRef.current?.focus();
  }, [isActive]);

  // Subscribe to IPC events for this session
  useEffect(() => {
    const electron = window.electron;
    if (!electron) return;

    const { sessionId } = session;

    const unsubToken = electron.piAgent.onToken((e) => {
      if (e.sessionId !== sessionId) return;
      appendPiToken(sessionId, e.delta);
    });

    const unsubTool = electron.piAgent.onTool((e) => {
      if (e.sessionId !== sessionId) return;
      if (e.status === "end") {
        addPiToolCall(sessionId, { name: e.name, label: e.label, ok: e.ok ?? true });
      }
    });

    const unsubDone = electron.piAgent.onDone((e) => {
      if (e.sessionId !== sessionId) return;
      finalisePiMessage(sessionId);
      setIsLoading(false);
    });

    const unsubError = electron.piAgent.onError((e) => {
      if (e.sessionId !== sessionId) return;
      finalisePiMessage(sessionId);
      addPiMessage(sessionId, {
        id:        id(),
        role:      "error",
        content:   e.error,
        timestamp: new Date().toISOString(),
      });
      setIsLoading(false);
    });

    return () => {
      unsubToken();
      unsubTool();
      unsubDone();
      unsubError();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.sessionId]);

  const sendPrompt = useCallback((text: string) => {
    const trimmed = text.trim();
    if (!trimmed || isLoading || !session.cwd) return;

    setInput("");
    setIsLoading(true);

    // Add user message to store
    addPiMessage(session.sessionId, {
      id:        id(),
      role:      "user",
      content:   trimmed,
      timestamp: new Date().toISOString(),
    });

    // Create placeholder streaming assistant message
    addPiMessage(session.sessionId, {
      id:          id(),
      role:        "assistant",
      content:     "",
      isStreaming: true,
      timestamp:   new Date().toISOString(),
    });

    window.electron?.piAgent.prompt({
      sessionId:   session.sessionId,
      prompt:      trimmed,
      projectId:   session.projectId,
      workspaceId: activeWorkspaceId ?? undefined,
      cwd:         session.cwd,
      taskTitle:   session.taskTitle !== "Ad-hoc session" ? session.taskTitle : undefined,
      config: {
        baseUrl: aiConfig.baseUrl || undefined,
        model:   aiConfig.model   || undefined,
        apiKey:  aiConfig.apiKey  || undefined,
      },
    });
  }, [isLoading, session, aiConfig, activeWorkspaceId, addPiMessage]);

  function handleStop() {
    window.electron?.piAgent.abort(session.sessionId);
    finalisePiMessage(session.sessionId);
    setIsLoading(false);
  }

  function handleClear() {
    if (isLoading) handleStop();
    clearPiMessages(session.sessionId);
    window.electron?.piAgent.clear(session.sessionId);
  }

  return (
    <div className="flex flex-col h-full bg-[var(--background)]">

      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-[var(--border)] bg-[var(--surface)] flex-shrink-0">
        <span className="text-[0.714rem] text-[var(--text-tertiary)] truncate flex-1">
          {session.taskTitle !== "Ad-hoc session" ? session.taskTitle : project?.name ?? "Cairn Agent"}
        </span>
        <Tooltip content="Clear conversation" side="left">
          <button
            onClick={handleClear}
            className="p-1 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)] transition-colors"
          >
            <Trash2 size={12} />
          </button>
        </Tooltip>
      </div>

      {/* Messages */}
      <div className="flex-1 min-h-0 overflow-y-auto px-3 py-3 space-y-3">
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full gap-2 text-center">
            <p className="text-[0.786rem] font-medium text-[var(--text-secondary)]">Cairn Agent</p>
            <p className="text-[0.714rem] text-[var(--text-tertiary)] max-w-48">
              Ask me to read, edit, or run code — or manage your project board.
            </p>
          </div>
        )}
        {messages.map((msg) => (
          <PiMessageBubble key={msg.id} message={msg} />
        ))}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="border-t border-[var(--border)] p-2 flex-shrink-0">
        <div className="relative">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                sendPrompt(input);
              }
            }}
            placeholder="Ask the agent…"
            rows={2}
            disabled={isLoading}
            className={cn(
              "w-full resize-none rounded-lg border border-[var(--border)] bg-[var(--surface-2)]",
              "px-2.5 py-2 pr-8 text-xs text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)]",
              "focus:outline-none focus:border-[var(--accent)] focus:ring-1 focus:ring-[var(--accent-dim)]",
              "transition-colors leading-relaxed disabled:opacity-60",
            )}
          />
          {isLoading ? (
            <Tooltip content="Stop" side="left">
              <button
                onClick={handleStop}
                className="absolute right-2 bottom-2 p-1 rounded text-[var(--danger)] hover:bg-[var(--danger)]/10 transition-colors"
              >
                <Square size={12} />
              </button>
            </Tooltip>
          ) : (
            <Tooltip content="Send (Enter)" side="left">
              <button
                onClick={() => sendPrompt(input)}
                disabled={!input.trim()}
                className="absolute right-2 bottom-2 p-1 rounded text-[var(--accent)] hover:bg-[var(--accent-dim)] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <Send size={12} />
              </button>
            </Tooltip>
          )}
        </div>
        <p className="text-[0.643rem] text-[var(--text-tertiary)] mt-1 text-center">
          {isLoading ? "Working… click ◼ to stop" : "Shift+Enter for new line · Enter to send"}
        </p>
      </div>
    </div>
  );
}
