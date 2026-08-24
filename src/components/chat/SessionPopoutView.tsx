"use client";

/**
 * The popout boundary is deliberately separate from ChatPanel. ChatPanel is
 * the legacy project drawer surface and owns the chat-thread Zustand view;
 * this view is session-bound and uses the dsh session projection as truth.
 */
import { useEffect, useRef, useState } from "react";
import { ArrowLeftFromLine } from "lucide-react";
import { useCairnStore } from "@/store";
import { ConversationComposer } from "@/components/conversation/ConversationComposer";
import { ConversationHeader } from "@/components/conversation/ConversationHeader";
import { ConversationTranscript } from "@/components/conversation/ConversationTranscript";
import { ConversationMessageBubble } from "@/components/conversation/ConversationMessageBubble";
import { ConversationEmptyState } from "@/components/conversation/ConversationEmptyState";
import { toConversationMessage } from "@/components/conversation/conversation-message";
import { cn } from "@/lib/utils";
import { createSessionEventFold } from "../../../shared/agent/session-event-fold";
import type { ChatHistoryEntry, ChatMessage } from "@/types";

interface SessionPopoutViewProps {
  sessionId: string;
  activeProjectId: string | null;
  onPopIn: () => void;
}

function unwrapMessages(value: unknown): ChatMessage[] {
  const raw = value && typeof value === "object" && "data" in value
    ? (value as { data?: unknown }).data
    : value;
  if (Array.isArray(raw)) return raw as ChatMessage[];
  if (raw && typeof raw === "object" && "messages" in raw && Array.isArray((raw as { messages?: unknown }).messages)) {
    return (raw as { messages: ChatMessage[] }).messages;
  }
  return [];
}

function historyFor(messages: ChatMessage[]): ChatHistoryEntry[] {
  const history: ChatHistoryEntry[] = [];
  messages.forEach((message) => {
    if (message.role === "user") {
      history.push({ role: "user", content: message.content || "" });
      return;
    }
    if (message.role === "assistant") {
      const toolCalls = message.toolCalls?.filter((call) => call.callId && call.args);
      history.push({
        role: "assistant" as const,
        content: message.content || null,
        ...(toolCalls?.length ? { tool_calls: toolCalls.map((call) => ({ id: call.callId!, type: "function" as const, function: { name: call.tool, arguments: call.args! } })) } : {}),
        ...(message.reasoning ? { reasoning: message.reasoning } : {}),
      });
      return;
    }
    history.push({ role: "system", content: message.content || "" });
  });
  return history;
}

/** A small session controller for the window that must not share chat state. */
export function SessionPopoutView({ sessionId, activeProjectId, onPopIn }: SessionPopoutViewProps) {
  const threadId = sessionId.startsWith("chat-") ? sessionId.slice(5) : sessionId;
  const aiConfig = useCairnStore((s) => s.aiConfig);
  const activeWorkspaceId = useCairnStore((s) => s.activeWorkspaceId);
  const project = useCairnStore((s) => s.projects.find((item) => item.id === activeProjectId));
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const messagesRef = useRef(messages);
  const loadingRef = useRef(false);
  const refresh = async () => {
    const result = await window.electron?.chat.sessionMessages(threadId);
    const next = unwrapMessages(result);
    messagesRef.current = next;
    setMessages(next);
  };

  useEffect(() => {
    // The initial replay is asynchronous because the session log is owned by
    // Electron, not by the renderer store.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
    const electron = window.electron;
    if (!electron?.session?.onEvent) return;
    const fold = createSessionEventFold({
      onTurnStart: () => { loadingRef.current = true; setLoading(true); },
      onTurnEnd: () => { loadingRef.current = false; setLoading(false); void refresh(); },
    });
    const unsubscribe = electron.session.onEvent((envelope) => {
      if (envelope.sessionId === sessionId) fold(envelope.event);
    });
    return () => { unsubscribe?.(); };
  // The session identity is immutable for a popout window.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, threadId]);

  async function send(text?: string) {
    const content = (text ?? input).trim();
    if (!content || loadingRef.current) return;
    setInput("");
    const optimistic: ChatMessage = {
      id: `popout-${Date.now()}`, threadId, role: "user", content,
      createdAt: new Date().toISOString(),
    };
    const next = [...messagesRef.current, optimistic];
    messagesRef.current = next;
    setMessages(next);
    loadingRef.current = true;
    setLoading(true);
    window.electron?.chat.stream({
      message: content,
      threadId,
      projectId: activeProjectId,
      workspaceId: activeWorkspaceId,
      history: historyFor(messagesRef.current.slice(0, -1)),
      config: {
        provider: aiConfig.provider || "openai", baseUrl: aiConfig.baseUrl || undefined,
        model: aiConfig.model || undefined, apiKey: aiConfig.apiKey || undefined,
        maxSteps: aiConfig.maxSteps ?? 30, contextLimit: aiConfig.contextLimit,
        contextWindow: aiConfig.contextLimit,
      },
    });
  }

  return (
    <div className="chat-themed flex flex-1 flex-col min-h-0 overflow-hidden">
      <ConversationHeader
        title={<span className="text-[0.714rem] font-semibold text-[var(--text-primary)]">{project?.name ?? "Chat"}</span>}
        contextLimit={aiConfig.contextLimit ?? 128000}
        actions={<button onClick={onPopIn} className="p-1 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)]" aria-label="Return chat to main window"><ArrowLeftFromLine size={11} /></button>}
      />
      <ConversationTranscript
        className="flex-1 min-h-0"
        data={messages}
        initialTopMostItemIndex={Math.max(0, messages.length - 1)}
        emptyPlaceholder={() => <ConversationEmptyState />}
        footer={() => <div className="px-3 py-3 text-xs text-[var(--text-tertiary)]">{loading ? "Cairn is working…" : ""}</div>}
        itemContent={(_index, message) => (
          <div className={cn("px-3 py-1.5")}><ConversationMessageBubble message={toConversationMessage(message)} /></div>
        )}
      />
      <ConversationComposer value={input} onChange={setInput} onSubmit={send} onStop={() => window.electron?.chat.abort()} isLoading={loading} placeholder="Ask about your project…" statusText="Shift+Enter for new line · Enter to send" />
    </div>
  );
}
