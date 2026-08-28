"use client";

import { useRef } from "react";
import { useCairnStore } from "@/store";
import type { SuggestedAction, ChatHistoryEntry } from "@/types";
import { useSessionConversation } from "./useSessionConversation";
import type { ConversationLiveToolCall, PendingQuestion as ConversationPendingQuestion, PendingQuestionOption as ConversationPendingQuestionOption } from "@/components/conversation/conversation-message";

// These now live in the shared conversation layer so the profile-neutral
// components no longer import from the chat hook. Re-exported here because
// chat call sites (and tests) refer to them by these names.
export type ChatToolCall = ConversationLiveToolCall;
export type PendingQuestionOption = ConversationPendingQuestionOption;
export type PendingQuestion = ConversationPendingQuestion;

export interface ChatStreamRequest {
  message: string;
  threadId: string;
  projectId: string | null | undefined;
  workspaceId: string | null | undefined;
  history: ChatHistoryEntry[];
  config: {
    provider?: string; baseUrl?: string; model?: string; apiKey?: string; maxSteps?: number; temperature?: number;
    maxTokens?: number; isReasoningModel?: boolean; reasoningEffort?: "off" | "low" | "medium" | "high"; apiMode?: "responses" | "completions" | "anthropic-messages"; contextLimit?: number; contextWindow?: number;
  };
  systemPrompt?: string;
  personality?: { name: string; prompt: string };
  images?: Array<{ name: string; dataUrl: string; kind?: "image" | "pdf" }>;
  useSubagents?: boolean;
}

export interface UseChatStreamResult {
  isLoading: boolean;
  toolCalls: ChatToolCall[];
  streamingContent: string;
  streamingThought: string;
  subagents: import("@/types").ChatSubagent[];
  pendingQuestions: PendingQuestion[] | null;
  pendingQuestionCallId: string | undefined;
  sendStream: (req: ChatStreamRequest) => void;
  stopStream: () => void;
  clearQuestions: () => void;
  answerQuestions: (answers: string) => boolean;
}

/** Chat's public API remains stable; session lifecycle and event folding live in the shared controller. */
export function useChatStream(threadId: string | null): UseChatStreamResult {
  const addMessage = useCairnStore((state) => state.addMessage);
  const setThreadUsage = useCairnStore((state) => state.setThreadUsage);
  const pendingActionsRef = useRef<SuggestedAction[]>([]);
  const controller = useSessionConversation({
    sessionId: threadId ? `chat-${threadId}` : null,
    acceptUnscopedEvents: true,
    adapter: {
      trackToolCall: (call) => call.name !== "ask_questions",
      onToolCall: (call) => {
        // The controller handles ask_questions via the typed question projection;
        // here we only capture suggest_connections' inline action payload.
        if (call.name === "suggest_connections") {
          pendingActionsRef.current = (call.args?.actions ?? []) as SuggestedAction[];
        }
      },
      onUsage: (usage) => { if (threadId) setThreadUsage(threadId, usage as never); },
      onTurnEnd: (reason, snapshot) => {
        if (!threadId) return;
        // Surface turn failures (blocked / error / max-tokens) — previously swallowed
        if (reason && reason !== "completed" && reason !== "aborted") {
          const msg = `Turn ended: ${reason}`;
          // Don't add empty assistant bubble if we already have text; surface as system notice
          if (!snapshot.text.trim()) {
            addMessage(threadId, "system", msg, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined as never);
          } else {
            // Append reason to assistant reasoning so user sees why it stopped
            addMessage(threadId, "assistant", snapshot.text, snapshot.assistant?.contextRefs as never, snapshot.toolCalls as never, pendingActionsRef.current, snapshot.thought ? `${snapshot.thought}\n\n[${msg}]` : `[${msg}]`, undefined, snapshot.subagents, undefined, undefined, undefined, undefined, snapshot.stats as never);
            pendingActionsRef.current = [];
            return;
          }
        }
        const assistant = snapshot.assistant;
        addMessage(threadId, "assistant", snapshot.text, assistant?.contextRefs as never, snapshot.toolCalls as never, pendingActionsRef.current, snapshot.thought, undefined, snapshot.subagents, undefined, undefined, undefined, undefined, snapshot.stats as never);
        if (assistant?.usage) setThreadUsage(threadId, assistant.usage as never);
        pendingActionsRef.current = [];
        if (snapshot.toolCalls.some((tool) => !["suggest_connections", "ask_questions"].includes(tool.tool) && !tool.tool.startsWith("get_") && !tool.tool.startsWith("list_") && !tool.tool.startsWith("search_")) || snapshot.subagents.some((agent) => (agent.toolCalls ?? []).some((tool) => !tool.tool.startsWith("get_") && !tool.tool.startsWith("list_") && !tool.tool.startsWith("search_")))) {
          useCairnStore.getState().hydrateFromElectron(true).catch((error) => console.error("[useChatStream] post-write hydrate failed", error));
        }
      },
    },
  });

  function sendStream(req: ChatStreamRequest) {
    controller.startPrompt(() => window.electron?.session.prompt({
      sessionId: `chat-${req.threadId}`, profile: "chat", prompt: req.message,
      projectId: req.projectId ?? undefined, workspaceId: req.workspaceId ?? undefined,
      attachments: req.images, history: req.history, systemPrompt: req.systemPrompt,
      personality: req.personality, useSubagents: req.useSubagents, config: req.config,
    }));
    if (threadId) setThreadUsage(threadId, undefined);
  }

  function stopStream() { controller.stop(); }
  return { ...controller, toolCalls: controller.toolCalls as ChatToolCall[], pendingQuestions: controller.pendingQuestions as PendingQuestion[] | null, sendStream, stopStream };
}
