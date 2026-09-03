"use client";

import { useEffect, useRef, useState } from "react";
import type { ChatSubagent, TokenBreakdown } from "@/types";
import { redactSensitiveText, redactToolOutput, redactTranscriptValue } from "@/lib/redact-agent-transcript";
import { createSessionEventFold, type FoldedToolCall, type FoldedToolResult, type FoldedUsage, type FoldedStats } from "../../shared/agent/session-event-fold";
import type { SessionEventEnvelope } from "../../shared/agent/session-event";
import type { SessionProjection } from "../../shared/agent/session-projection";
import { foldSessionStats } from "../../shared/session-stats";

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
  /** Tool-authored title from dsh `presentCall` (main-attached); humanize fallback otherwise. */
  viewTitle?: string;
  confirmRequired?: boolean;
  approvalNonce?: string;
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
  /** Per-turn throughput/latency captured live at turn end (TTFT · tok/s · out tokens). */
  stats?: FoldedStats;
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
  onTurnEnd?: (reason: string | undefined, snapshot: SessionConversationSnapshot, detail?: string) => void;
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
    ...(typeof call.view?.title === "string" && call.view.title ? { viewTitle: call.view.title } : {}),
  }];
}

export function resolveSessionToolResult(current: SessionConversationToolCall[], result: FoldedToolResult) {
  if (!result.callId) return current;
  return current.map((item) => item.callId === result.callId ? {
    // The approval card (confirmRequired) must clear once the tool actually
    // runs — otherwise the card stays as "Allow once / Always allow" until the
    // next turn's history reload, which is exactly the bug the user reported
    // (tool results only appearing on turn end).
    ...item, status: "done" as const, output: redactToolOutput(result.output), ok: result.ok,
    error: result.error ? redactSensitiveText(result.error) : undefined,
    confirmRequired: false, approvalNonce: undefined,
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
  const [questionNoncesBySession, setQuestionNoncesBySession] = useState<Record<string, string | undefined>>({});
  const textRef = useRef("");
  const thoughtRef = useRef("");
  const toolsRef = useRef<SessionConversationToolCall[]>([]);
  const subagentsRef = useRef<ChatSubagent[]>([]);
  const assistantRef = useRef<SessionConversationSnapshot["assistant"]>(undefined);
  const statsRef = useRef<FoldedStats | undefined>(undefined);
  const eventsRef = useRef<Array<{ type: string; time?: unknown; data?: unknown }>>([]);

  useEffect(() => {
    if (sessionIdRef.current !== sessionId) {
      // new session — drop prior log so live stats don't leak across sessions
      eventsRef.current = [];
    }
    sessionIdRef.current = sessionId;
    adapterRef.current = adapter;
  }, [sessionId, adapter]);

  const clearQuestionsFor = (id: string | null) => {
    if (!id) return;
    setQuestionsBySession((current) => { const next = { ...current }; delete next[id]; return next; });
    setQuestionCallsBySession((current) => { const next = { ...current }; delete next[id]; return next; });
    setQuestionNoncesBySession((current) => { const next = { ...current }; delete next[id]; return next; });
  };

  const resetTransient = (keepQuestions = false) => {
    setIsLoading(false); setStreamingContent(""); setStreamingThought(""); setToolCalls([]); setSubagents([]);
    textRef.current = ""; thoughtRef.current = ""; toolsRef.current = []; subagentsRef.current = []; assistantRef.current = undefined; statsRef.current = undefined;
    // keep eventsRef for live stats fallback until next turn/start clears it
    if (!keepQuestions) clearQuestionsFor(sessionIdRef.current);
  };

  useEffect(() => {
    const electron = window.electron;
    if (!electron?.session?.onEvent || !electron?.session?.onProjection) return;
    const matches = (id: string | undefined) => matchesSessionConversation(sessionIdRef.current, id, acceptUnscopedEvents);
    const updateSubagent = (childId: string, update: (value: ChatSubagent) => ChatSubagent) => {
      setSubagents((current) => { const next = current.map((item) => item.childId === childId ? update(item) : item); subagentsRef.current = next; return next; });
    };
    // Continuable children messaged from a cold pane never emitted `start`
    // here — materialize a minimal item so their follow-up traffic (and the
    // reply to a catalog message) renders instead of vanishing.
    const ensureSubagent = (childId: string) => {
      setSubagents((current) => {
        if (current.some((item) => item.childId === childId)) return current;
        const next = [...current, { childId, role: "subagent", instruction: "", content: "", toolCalls: [], running: true }];
        subagentsRef.current = next; return next;
      });
    };
    const fold = createSessionEventFold({
      onTurnStart: () => { eventsRef.current = []; statsRef.current = undefined; setIsLoading(true); adapterRef.current.onTurnStart?.(); },
      onText: (delta) => { textRef.current += delta; setStreamingContent((current) => current + delta); adapterRef.current.onText?.(delta); },
      onReasoning: (delta) => { thoughtRef.current += delta; setStreamingThought((current) => current + delta); adapterRef.current.onReasoning?.(delta); },
      onUsage: (usage) => adapterRef.current.onUsage?.(usage),
      onStats: (stats) => { statsRef.current = stats; },
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
      onTurnEnd: (reason, detail) => {
        // Live fallback: harness only derives stats on reload (foldSessionStats over the
        // durable log). If no stats chunk arrived, fold the turn's raw events (step/start,
        // assistant/chunk, assistant/message, tool/call) the same way the replay path does.
        let liveStats = statsRef.current;
        if (!liveStats && eventsRef.current.length > 0) {
          const folded = foldSessionStats(eventsRef.current);
          if (folded) {
            const turns = Object.keys(folded.byTurn).map(Number);
            const lastTurn = turns.length ? Math.max(...turns) : undefined;
            if (lastTurn !== undefined) liveStats = folded.byTurn[lastTurn];
            // also backfill aggregate for the composer's session line if needed
            if (!liveStats && folded.tokensPerSecond !== undefined) {
              liveStats = { tokensPerSecond: folded.tokensPerSecond };
            }
          }
        }
        const snapshot = { toolCalls: toolsRef.current.map((item) => item.status === "running" ? { ...item, status: "done" as const } : item), text: textRef.current, thought: thoughtRef.current, subagents: subagentsRef.current, assistant: assistantRef.current, stats: liveStats ?? statsRef.current };
        adapterRef.current.onTurnEnd?.(reason, snapshot, detail);
        resetTransient();
      },
      onCommand: (phase, data) => {
        const name = String(data.name ?? data.command ?? "command");
        const line = String(data.line ?? data.text ?? name);
        if (phase === "run") {
          const next = appendSessionToolCall(toolsRef.current, { name: `/${name}`, args: { line }, callId: String(data.id ?? data.commandId ?? `cmd-${Date.now()}`) });
          toolsRef.current = next; setToolCalls(next);
        } else {
          const callId = String((data as Record<string, unknown>).id ?? (data as Record<string, unknown>).commandId ?? "");
          const dataRec = data as Record<string, unknown>;
          const resultRec = dataRec.result as Record<string, unknown> | undefined;
          const output = typeof dataRec.text === "string" ? (dataRec.text as string) : typeof resultRec?.text === "string" ? (resultRec.text as string) : undefined;
          const ok = dataRec.kind === "success" || resultRec?.kind === "success";
          const result = { callId: callId || undefined, name: `/${name}`, output, error: ok ? undefined : output, ok: ok !== false } as import("../../shared/agent/session-event-fold").FoldedToolResult;
          if (callId) {
            const next = resolveSessionToolResult(toolsRef.current, result);
            toolsRef.current = next; setToolCalls(next);
          }
        }
      },
      onPlanMode: (active) => {
        const label = active ? "Entering plan mode" : "Leaving plan mode";
        const callId = `plan-${Date.now()}`;
        const next = appendSessionToolCall(toolsRef.current, { name: `plan:${active ? "on" : "off"}`, args: { status: label }, callId });
        toolsRef.current = next; setToolCalls(next);
        // auto-resolve after a short delay to render the chip as done — resolve by
        // the SAME callId we appended (recomputing Date.now() would never match).
        setTimeout(() => {
          const resolved = resolveSessionToolResult(toolsRef.current, { callId, name: `plan:${active ? "on" : "off"}`, ok: true, output: label } as never);
          toolsRef.current = resolved; setToolCalls(resolved);
        }, 50);
      },
      onRetry: (data) => {
        const attempt = String(data.attempt ?? data.retry ?? "?");
        const next = appendSessionToolCall(toolsRef.current, { name: "retry", args: { attempt, error: String(data.error ?? data.message ?? "") }, callId: `retry-${Date.now()}` });
        toolsRef.current = next; setToolCalls(next);
        setTimeout(() => {
          const resolved = resolveSessionToolResult(toolsRef.current, { callId: next[next.length - 1]?.callId, name: "retry", ok: true, output: `Retry ${attempt} scheduled` } as never);
          toolsRef.current = resolved; setToolCalls(resolved);
        }, 10);
      },
      onCompaction: (status) => {
        const label = status === "start" ? "Compacting context…" : status === "summary" ? "Summarizing…" : "Compaction done";
        const next = appendSessionToolCall(toolsRef.current, { name: `compact:${status}`, args: { status: label }, callId: `compact-${Date.now()}` });
        toolsRef.current = next; setToolCalls(next);
        if (status === "end") {
          setTimeout(() => {
            const resolved = toolsRef.current.map((t) => t.tool.startsWith("compact:") && t.status === "running" ? { ...t, status: "done" as const, ok: true } : t);
            toolsRef.current = resolved; setToolCalls(resolved);
          }, 300);
        }
      },
    });
    const unsubscribeEvent = electron.session.onEvent((envelope: SessionEventEnvelope) => {
      if (!matches(envelope.sessionId)) return;
      // keep raw events for live stats fallback (mirrors electron/cordis/session-replay.ts replay path)
      eventsRef.current.push(envelope.event as { type: string; time?: unknown; data?: unknown });
      fold(envelope.event);
    });
    const unsubscribeProjection = electron.session.onProjection((projection: SessionProjection) => {
      if (!matches(projection.sessionId)) return;
      const data = projection.data as Record<string, unknown>;
      const currentId = projection.sessionId;
      if (projection.kind === "question" && Array.isArray(data.questions)) {
        setQuestionsBySession((current) => ({ ...current, [currentId]: data.questions as SessionConversationQuestion[] }));
        setQuestionCallsBySession((current) => ({ ...current, [currentId]: typeof data.callId === "string" ? data.callId : undefined }));
        setQuestionNoncesBySession((current) => ({ ...current, [currentId]: typeof data.nonce === "string" ? data.nonce : undefined }));
      } else if (projection.kind === "subagent-trace" && data.parentSession === projection.sessionId) {
        const childId = String(data.childId ?? "");
        if (!childId) return;
        if (data.trace === "status" && data.status === "start") setSubagents((current) => {
          if (current.some((item) => item.childId === childId)) return current;
          const next = [...current, { childId, role: String(data.role ?? "subagent"), instruction: String(data.instruction ?? ""), content: "", toolCalls: [], running: true }]; subagentsRef.current = next; return next;
        });
        else if (data.trace === "status" && data.status === "done") updateSubagent(childId, (item) => ({ ...item, running: false, result: String(data.result ?? item.content) }));
        else if (data.trace === "token") { ensureSubagent(childId); updateSubagent(childId, (item) => ({ ...item, content: item.content + String(data.delta ?? "") })); }
        else if (data.trace === "thought") { ensureSubagent(childId); updateSubagent(childId, (item) => ({ ...item, reasoning: (item.reasoning ?? "") + String(data.delta ?? "") })); }
        else if (data.trace === "tool-call") { ensureSubagent(childId); updateSubagent(childId, (item) => ({ ...item, toolCalls: [...(item.toolCalls ?? []), { tool: String(data.tool), label: String(data.label ?? data.tool), callId: typeof data.callId === "string" ? data.callId : undefined, args: data.args ? JSON.stringify(redactTranscriptValue(data.args)) : undefined }] })); }
        else if (data.trace === "tool-done") updateSubagent(childId, (item) => ({ ...item, toolCalls: (item.toolCalls ?? []).map((tool) => tool.callId === data.callId ? { ...tool, output: redactToolOutput(typeof data.output === "string" ? data.output : undefined), ok: data.ok !== false, error: typeof data.error === "string" ? redactSensitiveText(data.error) : undefined } : tool) }));
         else if (data.trace === "usage") { ensureSubagent(childId); updateSubagent(childId, (item) => ({ ...item, lastUsage: { promptTokens: Number(data.promptTokens ?? 0), completionTokens: Number(data.completionTokens ?? 0), reasoningTokens: Number(data.reasoningTokens ?? 0), costUsd: typeof data.costUsd === "number" ? data.costUsd : undefined, breakdown: data.breakdown as TokenBreakdown | undefined } })); }
      } else if (projection.kind === "approval" && typeof data.callId === "string") {
        const next = toolsRef.current.map((item) => item.callId === data.callId
          ? { ...item, confirmRequired: data.status === "required", approvalNonce: typeof data.nonce === "string" ? data.nonce : undefined }
          : item);
        toolsRef.current = next;
        setToolCalls(next);
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
    const nonce = id ? questionNoncesBySession[id] : undefined;
    if (!id || !callId) return false;
    window.electron?.session.respondQuestions(id, callId, answers, nonce); clearQuestionsFor(id); return true;
  };
  const syncRunning = (running: boolean) => setIsLoading(running);
  const setToolApproval = (callId: string, required: boolean, nonce?: string) => {
    const next = toolsRef.current.map((item) => item.callId === callId
      ? { ...item, confirmRequired: required, approvalNonce: required ? nonce : undefined }
      : item);
    toolsRef.current = next;
    setToolCalls(next);
  };

  return {
    isLoading,
    streamingContent,
    streamingThought,
    toolCalls,
    subagents,
    pendingQuestions: sessionId ? questionsBySession[sessionId] ?? null : null,
    pendingQuestionCallId: sessionId ? questionCallsBySession[sessionId] : undefined,
    pendingQuestionNonce: sessionId ? questionNoncesBySession[sessionId] : undefined,
    startPrompt,
    syncRunning,
    setToolApproval,
    stop,
    clearQuestions,
    setQuestions: (questions: SessionConversationQuestion[] | null, callId?: string, nonce?: string) => {
      const id = sessionIdRef.current;
      if (!id) return;
      if (questions) {
        setQuestionsBySession((current) => ({ ...current, [id]: questions }));
        setQuestionCallsBySession((current) => ({ ...current, [id]: callId }));
        setQuestionNoncesBySession((current) => ({ ...current, [id]: nonce }));
      } else clearQuestionsFor(id);
    },
    answerQuestions,
  };
}
