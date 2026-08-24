"use client";

/**
 * useChatStream — manages the AI chat streaming lifecycle.
 *
 * Subscribes to the Electron chat events (onToken, onDone, onToolCall)
 * and exposes loading state, tool-call list, streaming content, and any
 * pending ask_questions form emitted by the agent.
 *
 * The component calls `sendStream()` to fire a request and reads back
 * the state updates as tokens/tool calls arrive.
 *
 * Tool calls are tracked with a per-call status ("running" | "done") so the
 * indicator can show a spinner on the active tool and a check on completed
 * ones. When the turn finishes, the full tool call list is persisted onto the
 * assistant ChatMessage so it remains visible in thread history.
 */

import { useState, useEffect, useRef } from "react";
import { useCairnStore } from "@/store";
import type { SuggestedAction, TokenBreakdown, ChatHistoryEntry, ChatSubagent } from "@/types";
import { redactSensitiveText, redactToolOutput, redactTranscriptValue } from "@/lib/redact-agent-transcript";
import { createSessionEventFold } from "../../shared/agent/session-event-fold";

export interface ChatToolCall {
  tool: string;
  label: string;
  /** "running" = currently executing; "done" = completed this turn */
  status: "running" | "done";
  cairnRef?: { type: "note" | "task"; id: string; title: string };
  externalRef?: { url: string; title?: string; snippet?: string };
  callId?: string;
  args?: string;
  output?: string;
  /** Tool execution status; `ok: false` + `error` when the tool failed. */
  ok?: boolean;
  error?: string;
  /** presentationMeta recomputed from the registered tool def (see ChatToolCallRecord). */
  meta?: Record<string, unknown>;
}

/**
 * One option in a dsh AskUserQuestionItem. dsh emits objects with a `label`
 * and (usually) a `description`; some ad-hoc callers pass strings.
 */
export type PendingQuestionOption = string | { label: string; description?: string };

/**
 * A pending clarification question the assistant asked the user to answer
 * inline. Two shapes are accepted so both Cairn's own `ask_questions` tool
 * and dsh-native providers (like plan-mode's `exit_plan_mode`, which uses
 * dsh's `AskUserQuestionItem`) render correctly:
 *
 *   * Cairn shape: `{id, label, prompt}` — how ask_questions has always
 *     handed off to the renderer. `label` is the short heading, `prompt`
 *     is the full question.
 *   * dsh shape: `{id, question, header?, detail?, options?, intent?}` —
 *     what the dsh-plan-mode plugin (and any future dsh-native ask surface)
 *     emits. `question` is the full question, `header` a short label,
 *     `detail` is a longer body block (plan-mode uses it to carry the FULL
 *     markdown plan for review — this is the load-bearing field for the
 *     plan-approval flow), `options` are the click-selectable choices, and
 *     `intent` is a UI-presentation hint (e.g. `{kind:'plan-review',
 *     approve:'Approve'}`) that lets a capable UI render a plan-review
 *     card instead of a generic question.
 *
 * The form component prefers dsh fields if they're present, so a payload
 * from either surface renders a filled-in card instead of a blank one.
 */
export interface PendingQuestion {
  id: string;
  /** Cairn shape */
  label?: string;
  prompt?: string;
  /** dsh shape */
  question?: string;
  header?: string;
  detail?: string;
  options?: PendingQuestionOption[];
  multiSelect?: boolean;
  intent?: { kind?: string; approve?: string; [k: string]: unknown };
}

export interface ChatStreamRequest {
  message: string;
  threadId: string;
  projectId: string | null | undefined;
  workspaceId: string | null | undefined;
  history: ChatHistoryEntry[];
  config: {
    provider?: string;
    baseUrl?: string;
    model?: string;
    apiKey?: string;
    maxSteps?: number;
    temperature?: number;
    /** Max output/completion tokens per reply (resolved from model + user setting). */
    maxTokens?: number;
    /** Whether the selected model is a reasoning/thinking model (from the models.dev catalog). */
    isReasoningModel?: boolean;
    /** Model token capacity limit (user setting or models.dev detected). */
    contextLimit?: number;
    contextWindow?: number;
  };
  systemPrompt?: string;
  /** Active chat personality — a style layer appended to the system prompt.
   *  Absent = Default (no personality). */
  personality?: { name: string; prompt: string };
  /** Attachments on the current user message (base64 data URLs; kind tells
   *  pdf from image so the main process can emit the right content part). */
  images?: Array<{ name: string; dataUrl: string; kind?: "image" | "pdf" }>;
  /** Route this turn through the dispatch → research/write subagent loop. */
  useSubagents?: boolean;
}

export interface UseChatStreamResult {
  isLoading: boolean;
  toolCalls: ChatToolCall[];
  streamingContent: string;
  /** Reasoning / thinking text streamed live from the model. Cleared on done. */
  streamingThought: string;
  /** Live subagent traces for the current turn (subagent mode). Cleared on done. */
  subagents: ChatSubagent[];
  /** Non-null when the agent has called ask_questions — cleared on submit or done. */
  pendingQuestions: PendingQuestion[] | null;
  /** The blocking request id for pendingQuestions (Cordis engine), else undefined. */
  pendingQuestionCallId: string | undefined;
  sendStream: (req: ChatStreamRequest) => void;
  stopStream: () => void;
  clearQuestions: () => void;
  /** Answer a blocking ask_questions same-turn; returns false if not blocking. */
  answerQuestions: (answers: string) => boolean;
}

export function useChatStream(threadId: string | null): UseChatStreamResult {
  const addMessage = useCairnStore((s) => s.addMessage);
  const setThreadUsage = useCairnStore((s) => s.setThreadUsage);

  const [isLoading, setIsLoading]               = useState(false);
  const [toolCalls, setToolCalls]               = useState<ChatToolCall[]>([]);
  const [streamingContent, setStreamingContent] = useState("");
  const [streamingThought, setStreamingThought] = useState("");
  // Pending questions are keyed by the thread they arrived on. The chat panel +
  // this hook are a single persistent instance that switches threads by changing
  // `threadId` (no remount), so a single slot would render under whatever thread
  // is active and get overwritten when a second thread also asks questions.
  // A per-thread map scopes each form to its own thread and preserves an
  // unanswered form when the user switches away and back.
  const [pendingQuestionsByThread, setPendingQuestionsByThread] =
    useState<Record<string, PendingQuestion[]>>({});
  // The blocking ask_questions request id (callId), per thread, for the Cordis
  // engine. When set, the form answers via session:respond-questions (same-turn);
  // when null (built-in engine), the form answers by starting a new user turn.
  const [pendingQuestionCallIdByThread, setPendingQuestionCallIdByThread] =
    useState<Record<string, string | undefined>>({});
  const [subagents, setSubagents] = useState<ChatSubagent[]>([]);

  const threadIdRef  = useRef<string | null>(null);
  // Accumulates tool calls for the current turn so they can be persisted on done.
  // A ref (not state) so the onDone closure always reads the latest value without
  // needing to be in the dependency array.
  const toolCallsRef = useRef<ChatToolCall[]>([]);
  const pendingActionsRef = useRef<SuggestedAction[]>([]);
  // Subagent traces for the current turn (parallel ref so onDone can persist them).
  const subagentsRef = useRef<ChatSubagent[]>([]);
  const streamedTextRef = useRef("");
  const streamedThoughtRef = useRef("");
  const assistantMessageRef = useRef<{ text: string; reasoning: string; contextRefs?: unknown[]; usage?: { promptTokens: number; completionTokens: number; reasoningTokens: number; cacheReadTokens?: number; cacheCreationTokens?: number; breakdown?: TokenBreakdown; costUsd?: number } }>({ text: "", reasoning: "" });

  useEffect(() => { threadIdRef.current = threadId; }, [threadId]);

  // Only surface pending questions that belong to the currently-active thread.
  const pendingQuestions =
    threadId && pendingQuestionsByThread[threadId]
      ? pendingQuestionsByThread[threadId]
      : null;
  const pendingQuestionCallId =
    threadId ? pendingQuestionCallIdByThread[threadId] : undefined;

  useEffect(() => {
    const electron = window.electron;
    if (!electron) return;

    // Ignore streaming events that belong to a different thread. The chat IPC
    // channel is shared app-wide (e.g. the note "Spawn tasks" button streams
    // under threadId "spawn-tasks"); without this filter those events would
    // toggle THIS panel's loading/message state and leave the input disabled.
    // Events without a threadId (older payloads) are treated as ours.
    const isForThisThread = (e: { sessionId?: string; threadId?: string }) =>
      e.sessionId == null || e.sessionId === (threadIdRef.current ? `chat-${threadIdRef.current}` : undefined);

    const fold = createSessionEventFold({
      onTurnStart: () => setIsLoading(true),
      onText: (delta) => { streamedTextRef.current += delta; setStreamingContent((prev) => prev + delta); },
      onReasoning: (delta) => { streamedThoughtRef.current += delta; setStreamingThought((prev) => prev + delta); },
      onUsage: (u) => { if (threadIdRef.current) setThreadUsage(threadIdRef.current, u as never); },
      onToolCall: (e) => {
        if (e.name === "ask_questions") {
          const qs = (e.args?.questions as PendingQuestion[] | undefined) ?? [];
          const forThread = threadIdRef.current;
          if (forThread) {
            setPendingQuestionsByThread((prev) => ({ ...prev, [forThread]: qs }));
            setPendingQuestionCallIdByThread((prev) => ({ ...prev, [forThread]: e.callId }));
          }
          return;
        }
        if (e.name === "suggest_connections") pendingActionsRef.current = (e.args?.actions ?? []) as SuggestedAction[];
        setToolCalls((prev) => {
          const next = [...prev.map((tc) => tc.status === "running" ? { ...tc, status: "done" as const } : tc), {
            tool: e.name, label: e.name, status: "running" as const, callId: e.callId,
            args: e.args ? JSON.stringify(redactTranscriptValue(e.args)) : undefined,
          }];
          toolCallsRef.current = next;
          return next;
        });
      },
      onToolResult: (e) => {
        setToolCalls((prev) => {
          const idx = e.callId ? prev.findIndex((tc) => tc.callId === e.callId) : -1;
          if (idx === -1) return prev;
          const updated = [...prev];
          updated[idx] = { ...updated[idx], status: "done", output: redactToolOutput(e.output), ok: e.ok, error: e.error ? redactSensitiveText(e.error) : undefined };
          toolCallsRef.current = updated;
          return updated;
        });
      },
      onAssistantMessage: (message) => { assistantMessageRef.current = message as typeof assistantMessageRef.current; },
      onTurnEnd: (reason) => {
        const tid = threadIdRef.current;
        const finalToolCalls = toolCallsRef.current.map((tc) => tc.status === "running" ? { ...tc, status: "done" as const } : tc);
        if (tid) {
          const final = assistantMessageRef.current;
          addMessage(tid, "assistant", streamedTextRef.current, final.contextRefs as never, finalToolCalls, pendingActionsRef.current, streamedThoughtRef.current, undefined, subagentsRef.current, undefined, undefined, undefined, undefined);
          if (final.usage) setThreadUsage(tid, final.usage);
        }
        const isWriteTool = (name: string) => !name.startsWith("get_") && !name.startsWith("list_") && !name.startsWith("search_") && name !== "suggest_connections" && name !== "ask_questions";
        if (finalToolCalls.some((tc) => isWriteTool(tc.tool)) || subagentsRef.current.flatMap((s) => s.toolCalls ?? []).some((tc) => isWriteTool(tc.tool))) {
          useCairnStore.getState().hydrateFromElectron(true).catch((err) => console.error("[useChatStream] post-write hydrate failed", err));
        }
        setStreamingContent(""); setStreamingThought(""); setIsLoading(false); setToolCalls([]); toolCallsRef.current = [];
        pendingActionsRef.current = []; setSubagents([]); subagentsRef.current = [];
        if (reason && reason !== "completed" && reason !== "aborted") console.error("[useChatStream] session turn ended:", reason);
      },
    });
    const unsubEvent = electron.session.onEvent((e) => {
      if (isForThisThread(e)) fold(e.event);
    });

    const unsubAskQuestions = electron.session.onAskQuestions((e) => {
      if (!isForThisThread(e)) return;
      const forThread = e.sessionId.startsWith("chat-") ? e.sessionId.slice(5) : threadIdRef.current;
      if (!forThread) return;
      setPendingQuestionsByThread((prev) => ({ ...prev, [forThread]: e.questions as PendingQuestion[] }));
      setPendingQuestionCallIdByThread((prev) => ({ ...prev, [forThread]: e.callId }));
    });

    // ── Subagent live trace (subagent mode) ──────────────────────────────────
    const mutateSub = (childId: string, fn: (s: ChatSubagent) => ChatSubagent) => {
      setSubagents((prev) => {
        const next = prev.map((s) => (s.childId === childId ? fn(s) : s));
        subagentsRef.current = next;
        return next;
      });
    };

    const unsubSub = electron.session.onSubagent?.((e) => {
      if (!isForThisThread(e)) return;
      if (e.status === "start") {
        setSubagents((prev) => {
          if (prev.some((s) => s.childId === e.childId)) return prev;
          const next = [...prev, {
            childId: e.childId, role: e.role, instruction: e.instruction ?? "",
            content: "", toolCalls: [], running: true,
          } as ChatSubagent];
          subagentsRef.current = next;
          return next;
        });
      } else {
        mutateSub(e.childId, (s) => ({ ...s, running: false, result: e.result ?? s.content }));
      }
    });

    const unsubSubToken = electron.session.onSubagentToken?.((e) => {
      if (!isForThisThread(e)) return;
      mutateSub(e.childId, (s) => ({ ...s, content: s.content + e.delta }));
    });

    const unsubSubThought = electron.session.onSubagentThought?.((e) => {
      if (!isForThisThread(e)) return;
      mutateSub(e.childId, (s) => ({ ...s, reasoning: (s.reasoning ?? "") + e.delta }));
    });

    const unsubSubTool = electron.session.onSubagentToolCall?.((e) => {
      if (!isForThisThread(e)) return;
      mutateSub(e.childId, (s) => ({
        ...s,
         toolCalls: [...(s.toolCalls ?? []), { tool: e.tool, label: e.label, callId: e.callId, args: e.args ? JSON.stringify(redactTranscriptValue(e.args)) : undefined }],
      }));
    });

    const unsubSubToolDone = electron.session.onSubagentToolCallDone?.((e) => {
      if (!isForThisThread(e)) return;
      mutateSub(e.childId, (s) => {
        const tcs = [...(s.toolCalls ?? [])];
        let idx = e.callId ? tcs.findIndex((t) => t.callId === e.callId) : -1;
        if (idx === -1) {
          const rev = [...tcs].reverse().findIndex((t) => t.tool === e.tool);
          if (rev !== -1) idx = tcs.length - 1 - rev;
        }
        if (idx !== -1) tcs[idx] = { ...tcs[idx], cairnRef: e.cairnRef, externalRef: e.externalRef, output: redactToolOutput(e.output), ok: e.ok, error: e.error ? redactSensitiveText(e.error) : e.error };
        return { ...s, toolCalls: tcs };
      });
    });

    const unsubSubUsage = electron.session.onSubagentUsage?.((e) => {
      if (!isForThisThread(e)) return;
      mutateSub(e.childId, (s) => ({
        ...s,
        lastUsage: { promptTokens: e.promptTokens, completionTokens: e.completionTokens, reasoningTokens: e.reasoningTokens, costUsd: e.costUsd, cacheReadTokens: e.cacheReadTokens, cacheCreationTokens: e.cacheCreationTokens, breakdown: e.breakdown as TokenBreakdown | undefined },
      }));
    });

    return () => {
      unsubEvent();
      unsubAskQuestions();
      unsubSub?.();
      unsubSubToken?.();
      unsubSubThought?.();
      unsubSubTool?.();
      unsubSubToolDone?.();
      unsubSubUsage?.();
    };
  // addMessage and setThreadUsage are stable (Zustand), intentionally omitted from deps
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function sendStream(req: ChatStreamRequest) {
    setIsLoading(true);
    setToolCalls([]);
    toolCallsRef.current = [];
    streamedTextRef.current = "";
    streamedThoughtRef.current = "";
    assistantMessageRef.current = { text: "", reasoning: "" };
    pendingActionsRef.current = [];
    setSubagents([]);
    subagentsRef.current = [];
    clearQuestionsForThread(threadId);
    if (threadId) {
      setThreadUsage(threadId, undefined);
    }
    setStreamingThought("");
    window.electron?.chat.stream(req);
  }

  function stopStream() {
    window.electron?.chat.abort();
    setIsLoading(false);
    setToolCalls([]);
    toolCallsRef.current = [];
    pendingActionsRef.current = [];
    setSubagents([]);
    subagentsRef.current = [];
    setStreamingContent("");
    setStreamingThought("");
    streamedTextRef.current = "";
    streamedThoughtRef.current = "";
    // Keep pendingQuestions — user may still want to answer after stopping
  }

  // Drop a single thread's pending questions (answered/cleared), leaving other
  // threads' unanswered forms intact.
  function clearQuestionsForThread(tid: string | null) {
    if (!tid) return;
    setPendingQuestionsByThread((prev) => {
      if (!(tid in prev)) return prev;
      const next = { ...prev };
      delete next[tid];
      return next;
    });
    setPendingQuestionCallIdByThread((prev) => {
      if (!(tid in prev)) return prev;
      const next = { ...prev };
      delete next[tid];
      return next;
    });
  }

  function clearQuestions() {
    clearQuestionsForThread(threadId);
  }

  // Answer a blocking ask_questions (Cordis engine): resolve the paused tool via
  // session:respond-questions so the answers feed back in the same turn, then clear
  // the form. `answers` is a JSON blob {answers:[{id,selected[],custom?}]} or
  // plain text. Returns true when it dispatched a blocking answer (a callId was
  // present); false lets the caller fall back to a new-turn send (built-in).
  function answerQuestions(answers: string): boolean {
    const callId = threadId ? pendingQuestionCallIdByThread[threadId] : undefined;
    if (!callId) return false;
    if (threadId) window.electron?.session.respondQuestions(`chat-${threadId}`, callId, answers);
    clearQuestionsForThread(threadId);
    return true;
  }

  return { isLoading, toolCalls, streamingContent, streamingThought, subagents, pendingQuestions, pendingQuestionCallId, sendStream, stopStream, clearQuestions, answerQuestions };
}
