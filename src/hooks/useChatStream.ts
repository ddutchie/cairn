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

export interface ChatToolCall {
  tool: string;
  label: string;
  /** "running" = currently executing; "done" = completed this turn */
  status: "running" | "done";
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
  history: Array<{ role: string; content: string }>;
  config: {
    baseUrl?: string;
    model?: string;
    apiKey?: string;
    maxSteps?: number;
    temperature?: number;
  };
  systemPrompt?: string;
}

export interface UseChatStreamResult {
  isLoading: boolean;
  toolCalls: ChatToolCall[];
  streamingContent: string;
  /** Non-null when the agent has called ask_questions — cleared on submit or done. */
  pendingQuestions: PendingQuestion[] | null;
  sendStream: (req: ChatStreamRequest) => void;
  stopStream: () => void;
  clearQuestions: () => void;
}

export function useChatStream(threadId: string | null): UseChatStreamResult {
  const addMessage = useCairnStore((s) => s.addMessage);

  const [isLoading, setIsLoading]               = useState(false);
  const [toolCalls, setToolCalls]               = useState<ChatToolCall[]>([]);
  const [streamingContent, setStreamingContent] = useState("");
  const [pendingQuestions, setPendingQuestions] = useState<PendingQuestion[] | null>(null);

  const threadIdRef  = useRef<string | null>(null);
  // Accumulates tool calls for the current turn so they can be persisted on done.
  // A ref (not state) so the onDone closure always reads the latest value without
  // needing to be in the dependency array.
  const toolCallsRef = useRef<ChatToolCall[]>([]);

  useEffect(() => { threadIdRef.current = threadId; }, [threadId]);

  useEffect(() => {
    const electron = window.electron;
    if (!electron) return;

    const unsubTool = electron.chat.onToolCall((e) => {
      if (e.tool === "ask_questions") {
        const qs = (e.args.questions as PendingQuestion[] | undefined) ?? [];
        setPendingQuestions(qs);
      } else {
        // Mark the previously-running tool as done, add the new one as running.
        setToolCalls((prev) => {
          const updated = prev.map((tc) =>
            tc.status === "running" ? { ...tc, status: "done" as const } : tc
          );
          const next = [...updated, { tool: e.tool, label: e.label, status: "running" as const }];
          toolCallsRef.current = next;
          return next;
        });
      }
    });

    const unsubToken = electron.chat.onToken((e) => {
      setStreamingContent((prev) => prev + e.delta);
    });

    const unsubDone = electron.chat.onDone((e) => {
      const tid = threadIdRef.current;
      // Mark any still-running tool as done before persisting.
      const finalToolCalls = toolCallsRef.current.map((tc) =>
        tc.status === "running" ? { ...tc, status: "done" as const } : tc
      );
      if (tid) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        addMessage(tid, "assistant", e.content, e.contextRefs as any, finalToolCalls);
      }
      setStreamingContent("");
      setIsLoading(false);
      setToolCalls([]);
      toolCallsRef.current = [];
      // Do NOT clear pendingQuestions here — the form must stay visible until
      // the user submits their answers. It is cleared in sendStream() instead.
    });

    return () => {
      unsubTool();
      unsubToken();
      unsubDone();
    };
  // addMessage is stable (Zustand), intentionally omitted from deps
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function sendStream(req: ChatStreamRequest) {
    setIsLoading(true);
    setToolCalls([]);
    toolCallsRef.current = [];
    setPendingQuestions(null);
    window.electron?.chat.stream(req);
  }

  function stopStream() {
    window.electron?.chat.abort();
    setIsLoading(false);
    setToolCalls([]);
    toolCallsRef.current = [];
    setStreamingContent("");
    // Keep pendingQuestions — user may still want to answer after stopping
  }

  function clearQuestions() {
    setPendingQuestions(null);
  }

  return { isLoading, toolCalls, streamingContent, pendingQuestions, sendStream, stopStream, clearQuestions };
}
