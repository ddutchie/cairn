"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowLeftFromLine } from "lucide-react";
import { useCairnStore } from "@/store";
import { useShallow } from "zustand/react/shallow";
import { ConversationComposer } from "@/components/conversation/ConversationComposer";
import { ConversationHeader } from "@/components/conversation/ConversationHeader";
import { ConversationTranscript } from "@/components/conversation/ConversationTranscript";
import { ConversationMessageBubble } from "@/components/conversation/ConversationMessageBubble";
import { ConversationEmptyState } from "@/components/conversation/ConversationEmptyState";
import { toConversationMessage, type ConversationMessage } from "@/components/conversation/conversation-message";
import { QuestionForm } from "@/components/chat/chat-panel/QuestionForm";
import { cn } from "@/lib/utils";
import { createSessionEventFold } from "../../../shared/agent/session-event-fold";
import { type ChatPopoutPayload } from "../../../shared/agent/chat-popout";
import type { AgentMessage, ChatMessage } from "@/types";
import type { PendingQuestion } from "@/hooks/useChatStream";
import type { SessionProjection } from "../../../shared/agent/session-projection";

type Props = Omit<ChatPopoutPayload, "profile"> & { profile: ChatPopoutPayload["profile"]; onPopIn: () => void };

function unwrap(value: unknown): Array<ChatMessage | AgentMessage> {
  const raw = value && typeof value === "object" && "data" in value ? (value as { data?: unknown }).data : value;
  if (Array.isArray(raw)) return raw as Array<ChatMessage | AgentMessage>;
  if (raw && typeof raw === "object" && "messages" in raw && Array.isArray((raw as { messages?: unknown }).messages)) return (raw as { messages: Array<ChatMessage | AgentMessage> }).messages;
  return [];
}

/** One session-bound conversation surface for both Chat and Coding profiles. */
export function SessionPopoutView({ sessionId, activeProjectId, profile, onPopIn }: Props) {
  const threadId = sessionId.startsWith("chat-") ? sessionId.slice(5) : sessionId;
  const { aiConfig, agentConfig, activeWorkspaceId, projects, terminalSessions } = useCairnStore(useShallow((s) => ({ aiConfig: s.aiConfig, agentConfig: s.agentConfig, activeWorkspaceId: s.activeWorkspaceId, projects: s.projects, terminalSessions: s.terminalSessions })));
  const codingSession = terminalSessions.find((item) => item.sessionId === sessionId);
  const project = projects.find((item) => item.id === activeProjectId);
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [questions, setQuestions] = useState<PendingQuestion[] | null>(null);
  const [questionCallId, setQuestionCallId] = useState<string | null>(null);
  const messagesRef = useRef(messages);
  const loadingRef = useRef(false);
  const refresh = async () => {
    const result = profile === "chat" ? await window.electron?.chat.sessionMessages(threadId) : await window.electron?.session.getSessionMessages(sessionId);
    const next = unwrap(result).map((message) => toConversationMessage(message));
    messagesRef.current = next;
    setMessages(next);
  };

  useEffect(() => {
    // The transcript is an external, asynchronously loaded session log.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
    const electron = window.electron;
    if (!electron?.session?.onEvent) return;
    void electron.session.isRunning(sessionId).then((state) => {
      if (state.running) { loadingRef.current = true; setLoading(true); }
      const pending = state.pendingQuestions?.[0];
      if (pending) { setQuestions(pending.questions as PendingQuestion[]); setQuestionCallId(pending.callId); }
      if (state.pendingAsks.length) setMessages((current) => current.map((message) => message.role === "assistant" ? { ...message, toolCalls: message.toolCalls?.map((tool) => state.pendingAsks.some((ask) => ask.callId === tool.callId) ? { ...tool, confirmRequired: true, approvalNonce: state.pendingAsks.find((ask) => ask.callId === tool.callId)?.nonce } : tool) } : message));
    }).catch(() => undefined);
    const fold = createSessionEventFold({
      onTurnStart: () => {
        loadingRef.current = true;
        setLoading(true);
        setMessages((current) => [...current, { id: `stream-${Date.now()}`, role: "assistant", content: "", isStreaming: true, createdAt: new Date().toISOString() }]);
      },
      onText: (delta) => setMessages((current) => { const next = [...current]; const last = next[next.length - 1]; if (last?.role === "assistant") next[next.length - 1] = { ...last, content: last.content + delta, isStreaming: true }; return next; }),
      onReasoning: (delta) => setMessages((current) => { const next = [...current]; const last = next[next.length - 1]; if (last?.role === "assistant") next[next.length - 1] = { ...last, reasoning: (last.reasoning ?? "") + delta, isStreaming: true }; return next; }),
      onToolCall: (call) => setMessages((current) => { const next = [...current]; const last = next[next.length - 1]; if (last?.role === "assistant") next[next.length - 1] = { ...last, toolCalls: [...(last.toolCalls ?? []), { callId: call.callId, name: call.name, label: call.name, args: call.args, running: true, ok: true }] }; return next; }),
      onToolResult: (result) => setMessages((current) => current.map((message) => message.role === "assistant" ? { ...message, toolCalls: message.toolCalls?.map((tool) => tool.callId === result.callId ? { ...tool, running: false, ok: result.ok, output: result.output, error: result.error, args: result.args } : tool) } : message)),
      onTurnEnd: () => { loadingRef.current = false; setLoading(false); setQuestions(null); setQuestionCallId(null); void refresh(); },
    });
    const unsubEvent = electron.session.onEvent((envelope) => { if (envelope.sessionId === sessionId) fold(envelope.event); });
    const unsubProjection = electron.session.onProjection((projection: SessionProjection) => {
      if (projection.sessionId !== sessionId) return;
      const data = projection.data as Record<string, unknown>;
      if (projection.kind === "approval") setMessages((current) => current.map((message) => message.role === "assistant" ? { ...message, toolCalls: message.toolCalls?.map((tool) => tool.callId === data.callId ? { ...tool, confirmRequired: data.status === "required", approvalNonce: typeof data.nonce === "string" ? data.nonce : undefined } : tool) } : message));
      if (projection.kind === "question" && Array.isArray(data.questions)) { setQuestions(data.questions as PendingQuestion[]); setQuestionCallId(typeof data.callId === "string" ? data.callId : null); }
    });
    return () => { unsubEvent?.(); unsubProjection?.(); };
    // The handed-off session is immutable for this window.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, profile, threadId]);

  function send(text?: string) {
    const content = (text ?? input).trim();
    if (!content || loadingRef.current) return;
    setInput("");
    const optimistic: ConversationMessage = { id: `popout-${Date.now()}`, role: "user", content, createdAt: new Date().toISOString() };
    const next = [...messagesRef.current, optimistic];
    messagesRef.current = next;
    setMessages(next);
    loadingRef.current = true;
    setLoading(true);
    window.electron?.session.prompt(profile === "chat"
      ? { sessionId, profile, prompt: content, projectId: activeProjectId ?? undefined, workspaceId: activeWorkspaceId ?? undefined, config: { provider: aiConfig.provider || "openai", baseUrl: aiConfig.baseUrl || undefined, model: aiConfig.model || undefined, apiKey: aiConfig.apiKey || undefined, maxSteps: aiConfig.maxSteps ?? 30, contextLimit: aiConfig.contextLimit, contextWindow: aiConfig.contextLimit } }
      : { sessionId, profile, prompt: content, projectId: activeProjectId ?? codingSession?.projectId, workspaceId: activeWorkspaceId ?? undefined, cwd: codingSession?.cwd, mode: "execute", config: agentConfig });
  }

  return <div className="chat-themed flex flex-1 flex-col min-h-0 overflow-hidden">
    <ConversationHeader title={<span className="text-[0.714rem] font-semibold text-[var(--text-primary)]">{project?.name ?? (profile === "coding" ? "Cairn Agent" : "Chat")}</span>} contextLimit={aiConfig.contextLimit ?? 128000} actions={<button onClick={onPopIn} className="p-1 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)]" aria-label="Return session to main window"><ArrowLeftFromLine size={11} /></button>} />
    <ConversationTranscript className="flex-1 min-h-0" data={messages} initialTopMostItemIndex={Math.max(0, messages.length - 1)} emptyPlaceholder={() => <ConversationEmptyState />} footer={() => <div className="px-3 py-3 text-xs text-[var(--text-tertiary)]">{loading ? "Cairn is working…" : ""}</div>} itemContent={(_index, message) => <div className={cn("px-3 py-1.5")}><ConversationMessageBubble message={message} sessionId={sessionId} /></div>} />
    {questions && <QuestionForm questions={questions} onSubmit={send} onSubmitStructured={questionCallId ? (answers) => { window.electron?.session.respondQuestions(sessionId, questionCallId, answers); setQuestions(null); setQuestionCallId(null); return true; } : undefined} />}
    <ConversationComposer value={input} onChange={setInput} onSubmit={send} onStop={() => window.electron?.session.abort(sessionId)} isLoading={loading} placeholder={profile === "coding" ? "Ask about your code…" : "Ask about your project…"} statusText="Shift+Enter for new line · Enter to send" />
  </div>;
}
