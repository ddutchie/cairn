"use client";

import { useEffect, useRef, useState } from "react";
import type { ChatSubagent, TokenBreakdown } from "@/types";
import { redactSensitiveText, redactToolOutput, redactTranscriptValue } from "@/lib/redact-agent-transcript";
import { createSessionEventFold, type FoldedToolCall, type FoldedToolResult, type FoldedUsage } from "../../shared/agent/session-event-fold";
import type { SessionEventEnvelope } from "../../shared/agent/session-event";
import type { SessionProjection } from "../../shared/agent/session-projection";

export interface SessionConversationToolCall {
  tool: string;
  label: string;
  status: "running" | "done";
  callId?: string;
  args?: string;
  output?: string;
  ok?: boolean;
  error?: string;
  meta?: Record<string, unknown>;
}

export type SessionConversationQuestion = {
  id: string;
  label?: string;
  prompt?: string;
  question?: string;
  header?: string;
  detail?: string;
  options?: (string | { label: string; description?: string })[];
  multiSelect?: boolean;
  intent?: { kind?: string; approve?: string; [key: string]: unknown };
};

export interface SessionConversationSnapshot {
  toolCalls: SessionConversationToolCall[];
  text: string;
  thought: string;
  subagents: ChatSubagent[];
  assistant?: { text: string; reasoning: string; contextRefs?: unknown[]; usage?: FoldedUsage };
}

export interface SessionConversationAdapter {
  onTurnStart?: () => void;
  onText?: (delta: string) => void;
  onReasoning?: (delta: string) => void;
  onUsage?: (usage: FoldedUsage) => void;
  onToolCall?: (call: FoldedToolCall) => void;
  trackToolCall?: (call: FoldedToolCall) => boolean;
  onToolResult?: (result: FoldedToolResult) => void;
  onAssistantMessage?: (message: SessionConversationSnapshot["assistant"]) => void;
  onTurnEnd?: (reason: string | undefined, snapshot: SessionConversationSnapshot) => void;
  onProjection?: (projection: SessionProjection) => void;
}

export interface UseSessionConversationOptions {
  /** The session id accepted by the event bus. It may change without remounting. */
  sessionId: string | null;
  /** Allows chat to accept the old unscoped event envelope while still filtering scoped events. */
  acceptUnscopedEvents?: boolean;
  adapter?: SessionConversationAdapter;
}

export function matchesSessionConversation(sessionId: string | null, eventSessionId: string | undefined, acceptUnscopedEvents = false) {
  return eventSessionId == null ? acceptUnscopedEvents : eventSessionId === sessionId;
}

export function appendSessionToolCall(current: SessionConversationToolCall[], call: FoldedToolCall) {
  return [...current.map((item) => item.status === "running" ? { ...item, status: "done" as const } : item), {
    tool: call.name, label: call.name, status: "running" as const, callId: call.callId,
    args: call.args ? JSON.stringify(redactTranscriptValue(call.args)) : undefined, meta: call.meta,
  }];
}

export function resolveSessionToolResult(current: SessionConversationToolCall[], result: FoldedToolResult) {
  if (!result.callId) return current;
  return current.map((item) => item.callId === result.callId ? {
    ...item, status: "done" as const, output: redactToolOutput(result.output), ok: result.ok,
    error: result.error ? redactSensitiveText(result.error) : undefined,
  } : item);
}

export function useSessionConversation({ sessionId, acceptUnscopedEvents = false, adapter = {} }: UseSessionConversationOptions) {
  const sessionIdRef = useRef(sessionId);
  const adapterRef = useRef(adapter);
  const [isLoading, setIsLoading] = useState(false);
  const [streamingContent, setStreamingContent] = useState("");
  const [streamingThought, setStreamingThought] = useState("");
  const [toolCalls, setToolCalls] = useState<SessionConversationToolCall[]>([]);
  const [subagents, setSubagents] = useState<ChatSubagent[]>([]);
  const [questionsBySession, setQuestionsBySession] = useState<Record<string, SessionConversationQuestion[]>>({});
  const [questionCallsBySession, setQuestionCallsBySession] = useState<Record<string, string | undefined>>({});
  const textRef = useRef("");
  const thoughtRef = useRef("");
  const toolsRef = useRef<SessionConversationToolCall[]>([]);
  const subagentsRef = useRef<ChatSubagent[]>([]);
  const assistantRef = useRef<SessionConversationSnapshot["assistant"]>(undefined);

  useEffect(() => {
    sessionIdRef.current = sessionId;
    adapterRef.current = adapter;
  }, [sessionId, adapter]);

  const clearQuestionsFor = (id: string | null) => {
    if (!id) return;
    setQuestionsBySession((current) => { const next = { ...current }; delete next[id]; return next; });
    setQuestionCallsBySession((current) => { const next = { ...current }; delete next[id]; return next; });
  };

  const resetTransient = (keepQuestions = false) => {
    setIsLoading(false); setStreamingContent(""); setStreamingThought(""); setToolCalls([]); setSubagents([]);
    textRef.current = ""; thoughtRef.current = ""; toolsRef.current = []; subagentsRef.current = []; assistantRef.current = undefined;
    if (!keepQuestions) clearQuestionsFor(sessionIdRef.current);
  };

  useEffect(() => {
    const electron = window.electron;
    if (!electron) return;
    const matches = (id: string | undefined) => matchesSessionConversation(sessionIdRef.current, id, acceptUnscopedEvents);
    const updateSubagent = (childId: string, update: (value: ChatSubagent) => ChatSubagent) => {
      setSubagents((current) => { const next = current.map((item) => item.childId === childId ? update(item) : item); subagentsRef.current = next; return next; });
    };
    const fold = createSessionEventFold({
      onTurnStart: () => { setIsLoading(true); adapterRef.current.onTurnStart?.(); },
      onText: (delta) => { textRef.current += delta; setStreamingContent((current) => current + delta); adapterRef.current.onText?.(delta); },
      onReasoning: (delta) => { thoughtRef.current += delta; setStreamingThought((current) => current + delta); adapterRef.current.onReasoning?.(delta); },
      onUsage: (usage) => adapterRef.current.onUsage?.(usage),
      onToolCall: (call) => {
        adapterRef.current.onToolCall?.(call);
        if (call.name === "ask_questions" && Array.isArray(call.args?.questions) && sessionIdRef.current) {
          setQuestionsBySession((current) => ({ ...current, [sessionIdRef.current!]: call.args!.questions as SessionConversationQuestion[] }));
          setQuestionCallsBySession((current) => ({ ...current, [sessionIdRef.current!]: call.callId }));
        }
        if (adapterRef.current.trackToolCall?.(call) === false) return;
        const next = appendSessionToolCall(toolsRef.current, call);
        toolsRef.current = next; setToolCalls(next);
      },
      onToolResult: (result) => {
        adapterRef.current.onToolResult?.(result);
        if (!result.callId) return;
        const next = resolveSessionToolResult(toolsRef.current, result);
        toolsRef.current = next; setToolCalls(next);
      },
      onAssistantMessage: (message) => { assistantRef.current = message; adapterRef.current.onAssistantMessage?.(message); },
      onTurnEnd: (reason) => {
        const snapshot = { toolCalls: toolsRef.current.map((item) => item.status === "running" ? { ...item, status: "done" as const } : item), text: textRef.current, thought: thoughtRef.current, subagents: subagentsRef.current, assistant: assistantRef.current };
        adapterRef.current.onTurnEnd?.(reason, snapshot);
        resetTransient();
      },
    });
    const unsubscribeEvent = electron.session.onEvent((envelope: SessionEventEnvelope) => { if (matches(envelope.sessionId)) fold(envelope.event); });
    const unsubscribeProjection = electron.session.onProjection((projection: SessionProjection) => {
      if (!matches(projection.sessionId)) return;
      const data = projection.data as Record<string, unknown>;
      const currentId = projection.sessionId;
      if (projection.kind === "question" && Array.isArray(data.questions)) {
        setQuestionsBySession((current) => ({ ...current, [currentId]: data.questions as SessionConversationQuestion[] }));
        setQuestionCallsBySession((current) => ({ ...current, [currentId]: typeof data.callId === "string" ? data.callId : undefined }));
      } else if (projection.kind === "subagent-trace" && data.parentSession === projection.sessionId) {
        const childId = String(data.childId ?? "");
        if (!childId) return;
        if (data.trace === "status" && data.status === "start") setSubagents((current) => {
          if (current.some((item) => item.childId === childId)) return current;
          const next = [...current, { childId, role: String(data.role ?? "subagent"), instruction: String(data.instruction ?? ""), content: "", toolCalls: [], running: true }]; subagentsRef.current = next; return next;
        });
        else if (data.trace === "status" && data.status === "done") updateSubagent(childId, (item) => ({ ...item, running: false, result: String(data.result ?? item.content) }));
        else if (data.trace === "token") updateSubagent(childId, (item) => ({ ...item, content: item.content + String(data.delta ?? "") }));
        else if (data.trace === "thought") updateSubagent(childId, (item) => ({ ...item, reasoning: (item.reasoning ?? "") + String(data.delta ?? "") }));
        else if (data.trace === "tool-call") updateSubagent(childId, (item) => ({ ...item, toolCalls: [...(item.toolCalls ?? []), { tool: String(data.tool), label: String(data.label ?? data.tool), callId: typeof data.callId === "string" ? data.callId : undefined, args: data.args ? JSON.stringify(redactTranscriptValue(data.args)) : undefined }] }));
        else if (data.trace === "tool-done") updateSubagent(childId, (item) => ({ ...item, toolCalls: (item.toolCalls ?? []).map((tool) => tool.callId === data.callId ? { ...tool, output: redactToolOutput(typeof data.output === "string" ? data.output : undefined), ok: data.ok !== false, error: typeof data.error === "string" ? redactSensitiveText(data.error) : undefined } : tool) }));
        else if (data.trace === "usage") updateSubagent(childId, (item) => ({ ...item, lastUsage: { promptTokens: Number(data.promptTokens ?? 0), completionTokens: Number(data.completionTokens ?? 0), reasoningTokens: Number(data.reasoningTokens ?? 0), costUsd: typeof data.costUsd === "number" ? data.costUsd : undefined, breakdown: data.breakdown as TokenBreakdown | undefined } }));
      }
      adapterRef.current.onProjection?.(projection);
    });
    return () => { unsubscribeEvent?.(); unsubscribeProjection?.(); };
    // The controller is intentionally mounted once; refs keep session and adapter current.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startPrompt = (dispatch: () => void) => { resetTransient(); setIsLoading(true); dispatch(); };
  const stop = () => { if (sessionIdRef.current) window.electron?.session.abort(sessionIdRef.current); resetTransient(true); };
  const clearQuestions = () => clearQuestionsFor(sessionIdRef.current);
  const answerQuestions = (answers: string) => {
    const id = sessionIdRef.current;
    const callId = id ? questionCallsBySession[id] : undefined;
    if (!id || !callId) return false;
    window.electron?.session.respondQuestions(id, callId, answers); clearQuestionsFor(id); return true;
  };

  return {
    isLoading,
    streamingContent,
    streamingThought,
    toolCalls,
    subagents,
    pendingQuestions: sessionId ? questionsBySession[sessionId] ?? null : null,
    pendingQuestionCallId: sessionId ? questionCallsBySession[sessionId] : undefined,
    startPrompt,
    stop,
    clearQuestions,
    setQuestions: (questions: SessionConversationQuestion[] | null, callId?: string) => {
      const id = sessionIdRef.current;
      if (!id) return;
      if (questions) {
        setQuestionsBySession((current) => ({ ...current, [id]: questions }));
        setQuestionCallsBySession((current) => ({ ...current, [id]: callId }));
      } else clearQuestionsFor(id);
    },
    answerQuestions,
  };
}
