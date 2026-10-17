"use client";

import { useEffect, useRef, useState } from "react";
import type { ChatSubagent, TokenBreakdown } from "@/types";
import { redactSensitiveText, redactToolOutput, redactTranscriptValue } from "@/lib/redact-agent-transcript";
import { cairnRefFromMeta, createSessionEventFold, type FoldedToolCall, type FoldedToolResult, type FoldedUsage, type FoldedStats, type RendererSessionEvent } from "../../shared/agent/session-event-fold";
import type { SessionEventEnvelope } from "../../shared/agent/session-event";
import type { SessionProjection } from "../../shared/agent/session-projection";
import { foldSessionStats } from "../../shared/session-stats";
import { createLiveStreamStore } from "@/lib/conversation/live-stream-store";

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
  /** Note/task the tool touched (from result `meta`); renders the clickable ref chip. */
  cairnRef?: { type: "note" | "task"; id: string; title: string };
  /** Tool-authored title from dsh `presentCall` (main-attached); humanize fallback otherwise. */
  viewTitle?: string;
  /** Tool-authored result view from dsh `presentResult` (main-attached); raw output fallback otherwise. */
  resultView?: { card?: string; title?: string; output?: string; exitCode?: number; signal?: string; content?: unknown };
  confirmRequired?: boolean;
  approvalNonce?: string;
  approvalReason?: string;
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
  onToolCall?: (call: FoldedToolCall, sessionId?: string) => void;
  trackToolCall?: (call: FoldedToolCall) => boolean;
  onToolResult?: (result: FoldedToolResult, sessionId?: string) => void;
  onAssistantMessage?: (message: SessionConversationSnapshot["assistant"]) => void;
  onTurnEnd?: (reason: string | undefined, snapshot: SessionConversationSnapshot, detail?: string, sessionId?: string) => void;
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
    // The persisted meta ref survives the 8k output truncation that breaks JSON parsing of large results.
    ...(cairnRefFromMeta(result.meta) ? { cairnRef: cairnRefFromMeta(result.meta) } : {}),
    error: result.error ? redactSensitiveText(result.error) : undefined,
    confirmRequired: false, approvalNonce: undefined, approvalReason: undefined,
    ...(result.resultView ? { resultView: result.resultView } : {}),
  } : item);
}

/** Live per-session accumulation. A single global bucket misattributes turns
 *  when the user switches threads mid-turn: the orphaned turn's completion
 *  never persists (its events stop matching the new session) while its
 *  partial text/cards keep rendering in the new thread — and the loading flag
 *  sticks, breaking the new thread. Keyed by session id (`null` → unscoped).
 */
interface SessionTransient {
  text: string;
  thought: string;
  tools: SessionConversationToolCall[];
  subagents: ChatSubagent[];
  assistant: SessionConversationSnapshot["assistant"];
  stats: FoldedStats | undefined;
  events: Array<{ type: string; time?: unknown; data?: unknown }>;
  running: boolean;
}

function newTransient(): SessionTransient {
  return { text: "", thought: "", tools: [], subagents: [], assistant: undefined, stats: undefined, events: [], running: false };
}

/** Map key for a (possibly undefined) event session id. */
function transientKey(id: string | undefined | null): string {
  return id ?? "\0unscoped";
}

export function useSessionConversation({ sessionId, acceptUnscopedEvents = false, adapter = {} }: UseSessionConversationOptions) {
  const sessionIdRef = useRef(sessionId);
  const adapterRef = useRef(adapter);
  const [isLoading, setIsLoading] = useState(false);
  // Streaming text lives in an external store, not React state: the live bubble
  // subscribes to it, so the owning panel doesn't re-render on every flush.
  const [streamStore] = useState(createLiveStreamStore);
  const setStreamText = (content: string, thought: string) => streamStore.set(content, thought);
  const [toolCalls, setToolCalls] = useState<SessionConversationToolCall[]>([]);
  const [subagents, setSubagents] = useState<ChatSubagent[]>([]);
  const [questionsBySession, setQuestionsBySession] = useState<Record<string, SessionConversationQuestion[]>>({});
  const [questionCallsBySession, setQuestionCallsBySession] = useState<Record<string, string | undefined>>({});
  const [questionNoncesBySession, setQuestionNoncesBySession] = useState<Record<string, string | undefined>>({});
  const transientsRef = useRef(new Map<string, SessionTransient>());
  const foldsRef = useRef(new Map<string, (event: RendererSessionEvent) => void>());
  /** Sessions with an unfinished turn launched through this controller that
   *  are not the active one — their events must still be folded so the turn
   *  completes into its own thread instead of vanishing. Populated only by
   *  this controller's own startPrompt (never by foreign sessions sharing the
   *  bus), so panes can't absorb each other's turns.
   */
  const watchedRef = useRef(new Set<string>());
  const getTransient = (key: string): SessionTransient => {
    let t = transientsRef.current.get(key);
    if (!t) {
      t = newTransient();
      transientsRef.current.set(key, t);
    }
    return t;
  };
  // Text/reasoning deltas arrive one IPC task per token; setting state on each
  // re-rendered (and re-parsed the growing markdown of) the pane per token —
  // quadratic over a long reply. Deltas accumulate in the transient above and
  // are flushed to state at most once per animation frame (active session only).
  const streamFrameRef = useRef(0);
  /** Copy a session's transient into the visible state (only when active). */
  const syncSessionUI = (id: string | null) => {
    if (id !== sessionIdRef.current) return;
    const t = transientsRef.current.get(transientKey(id));
    setIsLoading(t?.running ?? false);
    setStreamText(t?.text ?? "", t?.thought ?? "");
    setToolCalls(t ? [...t.tools] : []);
    setSubagents(t ? [...t.subagents] : []);
  };
  const scheduleStreamFlush = (id: string | null) => {
    if (id !== sessionIdRef.current) return;
    if (streamFrameRef.current) return;
    streamFrameRef.current = requestAnimationFrame(() => {
      streamFrameRef.current = 0;
      const t = transientsRef.current.get(transientKey(sessionIdRef.current));
      setStreamText(t?.text ?? "", t?.thought ?? "");
    });
  };
  const cancelStreamFlush = () => {
    cancelAnimationFrame(streamFrameRef.current);
    streamFrameRef.current = 0;
  };
  useEffect(() => cancelStreamFlush, []);

  useEffect(() => {
    adapterRef.current = adapter;
  });

  useEffect(() => {
    sessionIdRef.current = sessionId;
    // Show the newly active session's live state — never the previous
    // session's partial stream (the cross-thread "bleed"). Must run ONLY on
    // session change: the adapter object is inline (new identity every
    // render), so syncing on it would setState → re-render → loop forever.
    cancelStreamFlush();
    syncSessionUI(sessionId);
  }, [sessionId]);

  const clearQuestionsFor = (id: string | null) => {
    if (!id) return;
    setQuestionsBySession((current) => { const next = { ...current }; delete next[id]; return next; });
    setQuestionCallsBySession((current) => { const next = { ...current }; delete next[id]; return next; });
    setQuestionNoncesBySession((current) => { const next = { ...current }; delete next[id]; return next; });
  };

  const resetTransientFor = (id: string | null, keepQuestions = false) => {
    const key = transientKey(id);
    transientsRef.current.set(key, newTransient());
    if (id === sessionIdRef.current) {
      cancelStreamFlush();
      setIsLoading(false); setStreamText("", ""); setToolCalls([]); setSubagents([]);
    }
    // keep events for live stats fallback until next turn/start clears it —
    // note the fresh transient starts with empty events, matching the old
    // behaviour where only turn/start cleared the log.
    if (!keepQuestions) clearQuestionsFor(id);
  };

  const resetTransient = (keepQuestions = false) => resetTransientFor(sessionIdRef.current, keepQuestions);

  useEffect(() => {
    const electron = window.electron;
    if (!electron?.session?.onEvent || !electron?.session?.onProjection) return;
    const matches = (id: string | undefined) =>
      matchesSessionConversation(sessionIdRef.current, id, acceptUnscopedEvents) ||
      (id != null && watchedRef.current.has(transientKey(id)));
    const isActive = (key: string) => key === transientKey(sessionIdRef.current);
    const updateSubagent = (key: string, childId: string, update: (value: ChatSubagent) => ChatSubagent) => {
      const t = getTransient(key);
      t.subagents = t.subagents.map((item) => item.childId === childId ? update(item) : item);
      if (isActive(key)) setSubagents([...t.subagents]);
    };
    // Continuable children messaged from a cold pane never emitted `start`
    // here — materialize a minimal item so their follow-up traffic (and the
    // reply to a catalog message) renders instead of vanishing.
    const ensureSubagent = (key: string, childId: string) => {
      const t = getTransient(key);
      if (t.subagents.some((item) => item.childId === childId)) return;
      t.subagents = [...t.subagents, { childId, role: "subagent", instruction: "", content: "", toolCalls: [], running: true }];
      if (isActive(key)) setSubagents([...t.subagents]);
    };
    const getFold = (key: string, eventSessionId: string | undefined) => {
      let fold = foldsRef.current.get(key);
      if (fold) return fold;
      fold = createSessionEventFold({
        onTurnStart: () => {
          const t = getTransient(key);
          t.text = ""; t.thought = ""; t.tools = []; t.subagents = [];
          t.assistant = undefined; t.stats = undefined; t.events = []; t.running = true;
          if (isActive(key)) {
            setIsLoading(true);
            setStreamText("", "");
            setToolCalls([]); setSubagents([]);
          }
          adapterRef.current.onTurnStart?.();
        },
        onText: (delta) => { const t = getTransient(key); t.text += delta; scheduleStreamFlush(eventSessionId ?? null); adapterRef.current.onText?.(delta); },
        onReasoning: (delta) => { const t = getTransient(key); t.thought += delta; scheduleStreamFlush(eventSessionId ?? null); adapterRef.current.onReasoning?.(delta); },
        onUsage: (usage) => adapterRef.current.onUsage?.(usage),
        onStats: (stats) => { getTransient(key).stats = stats; },
        onToolCall: (call) => {
          adapterRef.current.onToolCall?.(call, eventSessionId);
          const t = getTransient(key);
          if (call.name === "ask_questions" && Array.isArray(call.args?.questions) && eventSessionId) {
            setQuestionsBySession((current) => ({ ...current, [eventSessionId]: call.args!.questions as SessionConversationQuestion[] }));
            setQuestionCallsBySession((current) => ({ ...current, [eventSessionId]: call.callId }));
          }
          if (adapterRef.current.trackToolCall?.(call) === false) return;
          t.tools = appendSessionToolCall(t.tools, call);
          if (isActive(key)) setToolCalls([...t.tools]);
        },
        onToolResult: (result) => {
          adapterRef.current.onToolResult?.(result, eventSessionId);
          if (!result.callId) return;
          const t = getTransient(key);
          t.tools = resolveSessionToolResult(t.tools, result);
          if (isActive(key)) setToolCalls([...t.tools]);
        },
        onAssistantMessage: (message) => { getTransient(key).assistant = message; adapterRef.current.onAssistantMessage?.(message); },
        onTurnEnd: (reason, detail) => {
          const t = getTransient(key);
          // Live fallback: harness only derives stats on reload (foldSessionStats over the
          // durable log). If no stats chunk arrived, fold the turn's raw events (step/start,
          // assistant/chunk, assistant/message, tool/call) the same way the replay path does.
          let liveStats = t.stats;
          if (!liveStats && t.events.length > 0) {
            const folded = foldSessionStats(t.events);
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
          const snapshot = { toolCalls: t.tools.map((item) => item.status === "running" ? { ...item, status: "done" as const } : item), text: t.text, thought: t.thought, subagents: t.subagents, assistant: t.assistant, stats: liveStats ?? t.stats };
          adapterRef.current.onTurnEnd?.(reason, snapshot, detail, eventSessionId);
          watchedRef.current.delete(key);
          transientsRef.current.delete(key);
          foldsRef.current.delete(key);
          if (isActive(key)) {
            cancelStreamFlush();
            setIsLoading(false); setStreamText("", ""); setToolCalls([]); setSubagents([]);
          }
        },
        onCommand: (phase, data) => {
          const t = getTransient(key);
          const name = String(data.name ?? data.command ?? "command");
          const line = String(data.line ?? data.text ?? name);
          if (phase === "run") {
            t.tools = appendSessionToolCall(t.tools, { name: `/${name}`, args: { line }, callId: String(data.id ?? data.commandId ?? `cmd-${Date.now()}`) });
            if (isActive(key)) setToolCalls([...t.tools]);
          } else {
            const callId = String((data as Record<string, unknown>).id ?? (data as Record<string, unknown>).commandId ?? "");
            const dataRec = data as Record<string, unknown>;
            const resultRec = dataRec.result as Record<string, unknown> | undefined;
            const output = typeof dataRec.text === "string" ? (dataRec.text as string) : typeof resultRec?.text === "string" ? (resultRec.text as string) : undefined;
            const ok = dataRec.kind === "success" || resultRec?.kind === "success";
            const result = { callId: callId || undefined, name: `/${name}`, output, error: ok ? undefined : output, ok: ok !== false } as import("../../shared/agent/session-event-fold").FoldedToolResult;
            if (callId) {
              t.tools = resolveSessionToolResult(t.tools, result);
              if (isActive(key)) setToolCalls([...t.tools]);
            }
          }
        },
        onPlanMode: (active) => {
          const t = getTransient(key);
          const label = active ? "Entering plan mode" : "Leaving plan mode";
          const callId = `plan-${Date.now()}`;
          t.tools = appendSessionToolCall(t.tools, { name: `plan:${active ? "on" : "off"}`, args: { status: label }, callId });
          if (isActive(key)) setToolCalls([...t.tools]);
          // auto-resolve after a short delay to render the chip as done — resolve by
          // the SAME callId we appended (recomputing Date.now() would never match).
          setTimeout(() => {
            const cur = getTransient(key);
            cur.tools = resolveSessionToolResult(cur.tools, { callId, name: `plan:${active ? "on" : "off"}`, ok: true, output: label } as never);
            if (isActive(key)) setToolCalls([...cur.tools]);
          }, 50);
        },
        onRetry: (data) => {
          const t = getTransient(key);
          const attempt = String(data.attempt ?? data.retry ?? "?");
          t.tools = appendSessionToolCall(t.tools, { name: "retry", args: { attempt, error: String(data.error ?? data.message ?? "") }, callId: `retry-${Date.now()}` });
          if (isActive(key)) setToolCalls([...t.tools]);
          setTimeout(() => {
            const cur = getTransient(key);
            cur.tools = resolveSessionToolResult(cur.tools, { callId: cur.tools[cur.tools.length - 1]?.callId, name: "retry", ok: true, output: `Retry ${attempt} scheduled` } as never);
            if (isActive(key)) setToolCalls([...cur.tools]);
          }, 10);
        },
        onCompaction: (status) => {
          const t = getTransient(key);
          const label = status === "start" ? "Compacting context…" : status === "summary" ? "Summarizing…" : "Compaction done";
          t.tools = appendSessionToolCall(t.tools, { name: `compact:${status}`, args: { status: label }, callId: `compact-${Date.now()}` });
          if (isActive(key)) setToolCalls([...t.tools]);
          if (status === "end") {
            setTimeout(() => {
              const cur = getTransient(key);
              cur.tools = cur.tools.map((tool) => tool.tool.startsWith("compact:") && tool.status === "running" ? { ...tool, status: "done" as const, ok: true } : tool);
              if (isActive(key)) setToolCalls([...cur.tools]);
            }, 300);
          }
        },
      });
      foldsRef.current.set(key, fold);
      return fold;
    };
    const unsubscribeEvent = electron.session.onEvent((envelope: SessionEventEnvelope) => {
      const key = transientKey(envelope.sessionId);
      if (!matches(envelope.sessionId) && !watchedRef.current.has(key)) return;
      // keep raw events for live stats fallback (mirrors electron/cordis/session-replay.ts replay path)
      getTransient(key).events.push(envelope.event as { type: string; time?: unknown; data?: unknown });
      getFold(key, envelope.sessionId)(envelope.event);
    });
    const unsubscribeProjection = electron.session.onProjection((projection: SessionProjection) => {
      // Same routing as events: the active session plus this controller's
      // unfinished background turns (otherwise e.g. a background approval
      // card would never reach its transient).
      if (!matches(projection.sessionId) && !watchedRef.current.has(transientKey(projection.sessionId))) return;
      const key = transientKey(projection.sessionId);
      const data = projection.data as Record<string, unknown>;
      const currentId = projection.sessionId;
      if (projection.kind === "question" && Array.isArray(data.questions)) {
        setQuestionsBySession((current) => ({ ...current, [currentId]: data.questions as SessionConversationQuestion[] }));
        setQuestionCallsBySession((current) => ({ ...current, [currentId]: typeof data.callId === "string" ? data.callId : undefined }));
        setQuestionNoncesBySession((current) => ({ ...current, [currentId]: typeof data.nonce === "string" ? data.nonce : undefined }));
      } else if (projection.kind === "subagent-trace" && data.parentSession === projection.sessionId) {
        const childId = String(data.childId ?? "");
        if (!childId) return;
        if (data.trace === "status" && data.status === "start") {
          const t = getTransient(key);
          if (!t.subagents.some((item) => item.childId === childId)) {
            t.subagents = [...t.subagents, { childId, role: String(data.role ?? "subagent"), instruction: String(data.instruction ?? ""), content: "", toolCalls: [], running: true }];
            if (isActive(key)) setSubagents([...t.subagents]);
          }
        }
        else if (data.trace === "status" && data.status === "done") updateSubagent(key, childId, (item) => ({ ...item, running: false, result: String(data.result ?? item.content) }));
        else if (data.trace === "token") { ensureSubagent(key, childId); updateSubagent(key, childId, (item) => ({ ...item, content: item.content + String(data.delta ?? "") })); }
        else if (data.trace === "thought") { ensureSubagent(key, childId); updateSubagent(key, childId, (item) => ({ ...item, reasoning: (item.reasoning ?? "") + String(data.delta ?? "") })); }
        else if (data.trace === "tool-call") { ensureSubagent(key, childId); updateSubagent(key, childId, (item) => ({ ...item, toolCalls: [...(item.toolCalls ?? []), { tool: String(data.tool), label: String(data.label ?? data.tool), callId: typeof data.callId === "string" ? data.callId : undefined, args: data.args ? JSON.stringify(redactTranscriptValue(data.args)) : undefined }] })); }
        else if (data.trace === "tool-done") updateSubagent(key, childId, (item) => ({ ...item, toolCalls: (item.toolCalls ?? []).map((tool) => tool.callId === data.callId ? { ...tool, output: redactToolOutput(typeof data.output === "string" ? data.output : undefined), ok: data.ok !== false, error: typeof data.error === "string" ? redactSensitiveText(data.error) : undefined } : tool) }));
         else if (data.trace === "usage") { ensureSubagent(key, childId); updateSubagent(key, childId, (item) => ({ ...item, lastUsage: { promptTokens: Number(data.promptTokens ?? 0), completionTokens: Number(data.completionTokens ?? 0), reasoningTokens: Number(data.reasoningTokens ?? 0), costUsd: typeof data.costUsd === "number" ? data.costUsd : undefined, breakdown: data.breakdown as TokenBreakdown | undefined } })); }
      } else if (projection.kind === "approval" && typeof data.callId === "string") {
        const t = getTransient(key);
        t.tools = t.tools.map((item) => item.callId === data.callId
          ? { ...item, confirmRequired: data.status === "required", approvalNonce: typeof data.nonce === "string" ? data.nonce : undefined, approvalReason: typeof data.reason === "string" ? data.reason : undefined }
          : item);
        if (isActive(key)) setToolCalls([...t.tools]);
      }
      adapterRef.current.onProjection?.(projection);
    });
    return () => { unsubscribeEvent?.(); unsubscribeProjection?.(); };
    // The controller is intentionally mounted once; refs keep session and adapter current.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startPrompt = (dispatch: () => void, promptSessionId?: string | null) => {
    const id = promptSessionId ?? sessionIdRef.current;
    watchedRef.current.add(transientKey(id));
    resetTransientFor(id);
    if (id === sessionIdRef.current) setIsLoading(true);
    dispatch();
  };
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
    const key = transientKey(sessionIdRef.current);
    const t = getTransient(key);
    t.tools = t.tools.map((item) => item.callId === callId
      ? { ...item, confirmRequired: required, approvalNonce: required ? nonce : undefined }
      : item);
    setToolCalls([...t.tools]);
  };

  return {
    isLoading,
    streamStore,
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
