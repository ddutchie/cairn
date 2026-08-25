"use client";

import { useCallback, useEffect, useState } from "react";
import { ArrowLeftFromLine } from "lucide-react";
import { useCairnStore } from "@/store";
import { useShallow } from "zustand/react/shallow";
import { ConversationPane } from "@/components/conversation/ConversationPane";
import type { ConversationMessage } from "@/components/conversation/conversation-message";
import { type ChatPopoutPayload } from "../../../shared/agent/chat-popout";
import { normalizeSessionMessages, applyApprovalProjection } from "@/components/conversation/conversation-session";
import { useSessionConversation } from "@/hooks/useSessionConversation";

type Props = ChatPopoutPayload & { onPopIn: () => void };

/** One session-bound conversation surface for both Chat and Coding profiles. */
export function SessionPopoutView({ sessionId, activeProjectId, profile, workspaceId, cwd, onPopIn }: Props) {
  const threadId = sessionId.startsWith("chat-") ? sessionId.slice(5) : sessionId;
  const { aiConfig, agentConfig, projects } = useCairnStore(useShallow((s) => ({ aiConfig: s.aiConfig, agentConfig: s.agentConfig, projects: s.projects })));
  const project = projects.find((item) => item.id === activeProjectId);
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [input, setInput] = useState("");
  const loadHistory = useCallback(async () => {
    const result = profile === "chat" ? await window.electron?.chat.sessionMessages(threadId) : await window.electron?.session.getSessionMessages(sessionId);
    return normalizeSessionMessages(result);
  }, [profile, sessionId, threadId]);
  const handleHistoryLoaded = useCallback((next: ConversationMessage[]) => {
    setMessages(next);
  }, []);
  const sessionConversation = useSessionConversation({
    sessionId,
    acceptUnscopedEvents: profile === "chat",
    adapter: {
      onTurnEnd: () => { void loadHistory().then(handleHistoryLoaded); },
      onProjection: (projection) => {
        if (projection.kind === "approval") setMessages((current) => applyApprovalProjection(current, projection.data as Record<string, unknown>));
      },
    },
  });
  const { isLoading, streamingContent, streamingThought, toolCalls, subagents, pendingQuestions, pendingQuestionCallId } = sessionConversation;
  const liveMessage: ConversationMessage | null = isLoading || streamingContent || streamingThought || toolCalls.length || subagents.length
    ? { id: `stream-${sessionId}`, role: "assistant", content: streamingContent, reasoning: streamingThought || undefined, toolCalls: toolCalls.map((tool) => ({ callId: tool.callId, name: tool.tool, label: tool.label, args: tool.args ? JSON.parse(tool.args) as Record<string, unknown> : undefined, running: tool.status === "running", ok: tool.ok !== false, output: tool.output, error: tool.error, meta: tool.meta, confirmRequired: tool.confirmRequired, approvalNonce: tool.approvalNonce })), subagents, isStreaming: true, createdAt: new Date().toISOString() }
    : null;
  const displayMessages = liveMessage ? [...messages, liveMessage] : messages;

  useEffect(() => {
    let cancelled = false;
    void window.electron?.session.isRunning(sessionId).then((state) => {
      if (cancelled) return;
      sessionConversation.syncRunning(state.running);
      const pending = state.pendingQuestions?.[0];
      if (pending) sessionConversation.setQuestions(pending.questions, pending.callId);
      for (const ask of state.pendingAsks) {
        sessionConversation.setToolApproval(ask.callId, true, ask.nonce);
        setMessages((current) => applyApprovalProjection(current, { callId: ask.callId, status: "required", nonce: ask.nonce }));
      }
    }).catch(() => undefined);
    return () => { cancelled = true; };
    // The handed-off session is immutable for this window.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  function send(text?: string) {
    const content = (text ?? input).trim();
    if (!content || isLoading) return;
    setInput("");
    const optimistic: ConversationMessage = { id: `popout-${Date.now()}`, role: "user", content, createdAt: new Date().toISOString() };
    setMessages((current) => [...current, optimistic]);
    sessionConversation.startPrompt(() => window.electron?.session.prompt(profile === "chat"
      ? { sessionId, profile, prompt: content, projectId: activeProjectId ?? undefined, workspaceId: workspaceId ?? undefined, config: { provider: aiConfig.provider || "openai", baseUrl: aiConfig.baseUrl || undefined, model: aiConfig.model || undefined, apiKey: aiConfig.apiKey || undefined, maxSteps: aiConfig.maxSteps ?? 30, contextLimit: aiConfig.contextLimit, contextWindow: aiConfig.contextLimit } }
      : { sessionId, profile, prompt: content, projectId: activeProjectId ?? undefined, workspaceId: workspaceId ?? undefined, cwd: cwd ?? undefined, mode: "execute", config: agentConfig }));
  }

  return <ConversationPane
    className="chat-themed"
    sessionId={sessionId}
    profile={profile}
    messages={displayMessages}
    input={input}
    onInputChange={setInput}
    onPrompt={(text) => send(text)}
    onAbort={sessionConversation.stop}
    isLoading={isLoading}
    historyLoader={loadHistory}
    onHistoryLoaded={handleHistoryLoaded}
    centered={profile === "chat"}
    title={<span className="text-[0.714rem] font-semibold text-[var(--text-primary)]">{project?.name ?? (profile === "coding" ? "Cairn Agent" : "Chat")}</span>}
    contextLimit={aiConfig.contextLimit ?? 128000}
    actions={<button onClick={onPopIn} className="p-1 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)]" aria-label="Return session to main window"><ArrowLeftFromLine size={11} /></button>}
    projection={{ pendingQuestions, questionCallId: pendingQuestionCallId }}
    onAnswerQuestions={sessionConversation.answerQuestions}
    placeholder={profile === "coding" ? "Ask about your code…" : "Ask about your project…"}
    composerProps={{ statusText: "Shift+Enter for new line · Enter to send" }}
  />;
}
