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
}

export interface PendingQuestion {
  id: string;
  label: string;
  prompt: string;
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
  };
  systemPrompt?: string;
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
  sendStream: (req: ChatStreamRequest) => void;
  stopStream: () => void;
  clearQuestions: () => void;
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
  const [subagents, setSubagents] = useState<ChatSubagent[]>([]);

  const threadIdRef  = useRef<string | null>(null);
  // Accumulates tool calls for the current turn so they can be persisted on done.
  // A ref (not state) so the onDone closure always reads the latest value without
  // needing to be in the dependency array.
  const toolCallsRef = useRef<ChatToolCall[]>([]);
  const pendingActionsRef = useRef<SuggestedAction[]>([]);
  // Subagent traces for the current turn (parallel ref so onDone can persist them).
  const subagentsRef = useRef<ChatSubagent[]>([]);

  useEffect(() => { threadIdRef.current = threadId; }, [threadId]);

  // Only surface pending questions that belong to the currently-active thread.
  const pendingQuestions =
    threadId && pendingQuestionsByThread[threadId]
      ? pendingQuestionsByThread[threadId]
      : null;

  useEffect(() => {
    const electron = window.electron;
    if (!electron) return;

    // Ignore streaming events that belong to a different thread. The chat IPC
    // channel is shared app-wide (e.g. the note "Spawn tasks" button streams
    // under threadId "spawn-tasks"); without this filter those events would
    // toggle THIS panel's loading/message state and leave the input disabled.
    // Events without a threadId (older payloads) are treated as ours.
    const isForThisThread = (e: { threadId?: string }) =>
      e.threadId == null || e.threadId === threadIdRef.current;

    const unsubTool = electron.chat.onToolCall((e) => {
      if (!isForThisThread(e)) return;
      if (e.tool === "ask_questions") {
        const qs = (e.args.questions as PendingQuestion[] | undefined) ?? [];
        // Store under the thread these questions arrived for, so the form only
        // renders in that thread (not whichever thread is active later) and a
        // second thread's questions don't clobber this one's.
        const forThread = e.threadId ?? threadIdRef.current;
        if (forThread) {
          setPendingQuestionsByThread((prev) => ({ ...prev, [forThread]: qs }));
        }
      } else {
        if (e.tool === "suggest_connections") {
          const incoming = (e.args.actions ?? []) as SuggestedAction[];
          pendingActionsRef.current = incoming;
        }
        // Mark the previously-running tool as done, add the new one as running.
        setToolCalls((prev) => {
          const updated = prev.map((tc) =>
            tc.status === "running" ? { ...tc, status: "done" as const } : tc
          );
          const next = [...updated, {
            tool: e.tool,
            label: e.label,
            status: "running" as const,
            callId: e.callId,
             args: e.args ? JSON.stringify(redactTranscriptValue(e.args)) : undefined
          }];
          toolCallsRef.current = next;
          return next;
        });
      }
    });

    const unsubToolDone = electron.chat.onToolCallDone?.((e) => {
      if (!isForThisThread(e)) return;
      setToolCalls((prev) => {
        let idx = -1;
        if (e.callId) {
          idx = prev.findIndex((tc) => tc.callId === e.callId);
        }
        if (idx === -1) {
          const lastIdx = [...prev].reverse().findIndex((tc) => tc.tool === e.tool);
          if (lastIdx !== -1) {
            idx = prev.length - 1 - lastIdx;
          }
        }
        if (idx === -1) return prev;
        const updated = [...prev];
        updated[idx] = { ...updated[idx], cairnRef: e.cairnRef, externalRef: e.externalRef, output: redactToolOutput(e.output), ok: e.ok, error: e.error ? redactSensitiveText(e.error) : e.error };
        toolCallsRef.current = updated;
        return updated;
      });
    });

    const unsubToken = electron.chat.onToken((e) => {
      if (!isForThisThread(e)) return;
      setStreamingContent((prev) => prev + e.delta);
    });

    const unsubThought = electron.chat.onThought?.((e) => {
      if (!isForThisThread(e)) return;
      setStreamingThought((prev) => prev + e.delta);
    });

    // ── Subagent live trace (subagent mode) ──────────────────────────────────
    const mutateSub = (childId: string, fn: (s: ChatSubagent) => ChatSubagent) => {
      setSubagents((prev) => {
        const next = prev.map((s) => (s.childId === childId ? fn(s) : s));
        subagentsRef.current = next;
        return next;
      });
    };

    const unsubSub = electron.chat.onSubagent?.((e) => {
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

    const unsubSubToken = electron.chat.onSubagentToken?.((e) => {
      if (!isForThisThread(e)) return;
      mutateSub(e.childId, (s) => ({ ...s, content: s.content + e.delta }));
    });

    const unsubSubThought = electron.chat.onSubagentThought?.((e) => {
      if (!isForThisThread(e)) return;
      mutateSub(e.childId, (s) => ({ ...s, reasoning: (s.reasoning ?? "") + e.delta }));
    });

    const unsubSubTool = electron.chat.onSubagentToolCall?.((e) => {
      if (!isForThisThread(e)) return;
      mutateSub(e.childId, (s) => ({
        ...s,
         toolCalls: [...(s.toolCalls ?? []), { tool: e.tool, label: e.label, callId: e.callId, args: e.args ? JSON.stringify(redactTranscriptValue(e.args)) : undefined }],
      }));
    });

    const unsubSubToolDone = electron.chat.onSubagentToolCallDone?.((e) => {
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

    const unsubSubUsage = electron.chat.onSubagentUsage?.((e) => {
      if (!isForThisThread(e)) return;
      mutateSub(e.childId, (s) => ({
        ...s,
        lastUsage: { promptTokens: e.promptTokens, completionTokens: e.completionTokens, reasoningTokens: e.reasoningTokens, costUsd: e.costUsd, cacheReadTokens: e.cacheReadTokens, cacheCreationTokens: e.cacheCreationTokens },
      }));
    });

    const unsubDone = (electron.chat.onDone as (cb: (e: { content: string; reasoning?: string; contextRefs: unknown[]; error?: string; threadId?: string; usage?: { promptTokens: number; completionTokens: number; reasoningTokens?: number; cacheReadTokens?: number; cacheCreationTokens?: number; breakdown?: TokenBreakdown; costUsd?: number } }) => void) => () => void)((e) => {
      if (!isForThisThread(e)) return;
      const tid = threadIdRef.current;
      // Mark any still-running tool as done before persisting.
      const finalToolCalls = toolCallsRef.current.map((tc) =>
        tc.status === "running" ? { ...tc, status: "done" as const } : tc
      );
      if (tid) {
        const capturedActions = pendingActionsRef.current;
        pendingActionsRef.current = [];
        const finalSubagents = subagentsRef.current.map((s) => ({ ...s, running: false }));
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        addMessage(tid, "assistant", e.content, e.contextRefs as any, finalToolCalls, capturedActions, e.reasoning, undefined, finalSubagents);
        if (e.usage) {
          setThreadUsage(tid, e.usage);
        }
      }
      setStreamingContent("");
      setStreamingThought("");
      setIsLoading(false);
      setToolCalls([]);
      toolCallsRef.current = [];
      pendingActionsRef.current = [];
      setSubagents([]);
      subagentsRef.current = [];
      // Do NOT clear pendingQuestions here — the form must stay visible until
      // the user submits their answers. It is cleared in sendStream() instead.

      // Force-refresh the store so AI-written changes (notes, tasks, etc.) are
      // immediately visible. The db:changed event from the chat tool writes is
      // suppressed by the ownWriteGuard (touched by the chat IPC call), so we
      // must explicitly re-hydrate here.
      // Only trigger for tools that actually persist state — exclude read-only
      // tools (get_*/list_*/search_*) and suggestion-only tools that stage
      // pendingActionsRef without writing to the DB.
      const isWriteTool = (name: string) => {
        if (name.startsWith("get_") || name.startsWith("list_") || name.startsWith("search_")) return false;
        if (name === "suggest_connections" || name === "ask_questions") return false;
        return true;
      };
      // In subagent mode, writes happen inside the write sub-agent's tool calls,
      // not the top-level list — check both so the board/notes still refresh.
      const subagentToolCalls = subagentsRef.current.flatMap((s) => s.toolCalls ?? []);
      const hasPersistedWrite =
        finalToolCalls.some((tc) => isWriteTool(tc.tool)) ||
        subagentToolCalls.some((tc) => isWriteTool(tc.tool));
      if (hasPersistedWrite) {
        useCairnStore.getState().hydrateFromElectron(true).catch((err) => {
          console.error("[useChatStream] post-write hydrate failed", err);
        });
      }
    });

    const unsubUsage = (electron.chat.onUsage as (cb: (e: { promptTokens: number; completionTokens: number; reasoningTokens?: number; cacheReadTokens?: number; cacheCreationTokens?: number; breakdown?: TokenBreakdown; costUsd?: number; threadId?: string }) => void) => () => void)((e) => {
      if (!isForThisThread(e)) return;
      const tid = threadIdRef.current;
      if (tid) {
        setThreadUsage(tid, e);
      }
    });

    return () => {
      unsubTool();
      unsubToolDone?.();
      unsubToken();
      unsubThought?.();
      unsubSub?.();
      unsubSubToken?.();
      unsubSubThought?.();
      unsubSubTool?.();
      unsubSubToolDone?.();
      unsubSubUsage?.();
      unsubDone();
      unsubUsage();
    };
  // addMessage and setThreadUsage are stable (Zustand), intentionally omitted from deps
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function sendStream(req: ChatStreamRequest) {
    setIsLoading(true);
    setToolCalls([]);
    toolCallsRef.current = [];
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
  }

  function clearQuestions() {
    clearQuestionsForThread(threadId);
  }

  return { isLoading, toolCalls, streamingContent, streamingThought, subagents, pendingQuestions, sendStream, stopStream, clearQuestions };
}
