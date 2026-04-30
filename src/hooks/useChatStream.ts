"use client";

/**
 * useChatStream — manages the AI chat streaming lifecycle.
 *
 * Subscribes to the Electron chat events (onToken, onDone, onToolCall)
 * and exposes loading state, tool-call list, and streaming content.
 *
 * The component calls `sendStream()` to fire a request and reads back
 * the state updates as tokens/tool calls arrive.
 */

import { useState, useEffect, useRef } from "react";
import { useCairnStore } from "@/store";

export interface ChatToolCall {
  tool: string;
  label: string;
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
  };
}

export interface UseChatStreamResult {
  isLoading: boolean;
  toolCalls: ChatToolCall[];
  streamingContent: string;
  sendStream: (req: ChatStreamRequest) => void;
}

export function useChatStream(threadId: string | null): UseChatStreamResult {
  const addMessage = useCairnStore((s) => s.addMessage);

  const [isLoading, setIsLoading] = useState(false);
  const [toolCalls, setToolCalls] = useState<ChatToolCall[]>([]);
  const [streamingContent, setStreamingContent] = useState("");

  // Keep a stable ref so the onDone handler always reads the latest threadId
  const threadIdRef = useRef<string | null>(null);
  useEffect(() => { threadIdRef.current = threadId; }, [threadId]);

  useEffect(() => {
    const electron = window.electron;
    if (!electron) return;

    const unsubTool = electron.chat.onToolCall((e) => {
      setToolCalls((prev) => [...prev, { tool: e.tool, label: e.label }]);
    });

    const unsubToken = electron.chat.onToken((e) => {
      setStreamingContent((prev) => prev + e.delta);
    });

    const unsubDone = electron.chat.onDone((e) => {
      const tid = threadIdRef.current;
      if (tid) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        addMessage(tid, "assistant", e.content, e.contextRefs as any);
      }
      setStreamingContent("");
      setIsLoading(false);
      setToolCalls([]);
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
    window.electron?.chat.stream(req);
  }

  return { isLoading, toolCalls, streamingContent, sendStream };
}
