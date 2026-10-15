"use client";

import { useRef } from "react";
import { useCairnStore } from "@/store";
import type { SuggestedAction, ChatHistoryEntry } from "@/types";
import { useSessionConversation } from "./useSessionConversation";
import type { ConversationLiveToolCall, PendingQuestion as ConversationPendingQuestion, PendingQuestionOption as ConversationPendingQuestionOption } from "@/lib/conversation/message";

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
  approvalPolicy?: import("../../shared/agent/chat-approval").ChatApprovalPolicy;
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
  const pendingActionsRef = useRef(new Map<string, SuggestedAction[]>());
  // The suggest_connections call staged per session. The executor validates
  // args and can reject a typeless call — without tracking this, a failed call
  // with no model retry would leave invalid actions persisted in the Apply
  // cards at turn end. Keyed by session so a thread switch can't leak one
  // thread's staged cards into another's turn.
  const pendingActionsCallIdRef = useRef(new Map<string, string | undefined>());
  const stagedActions = (sessionId: string | undefined): SuggestedAction[] =>
    pendingActionsRef.current.get(sessionId ?? "\0unscoped") ?? [];
  const clearStagedActions = (sessionId: string | undefined) => {
    const key = sessionId ?? "\0unscoped";
    pendingActionsRef.current.delete(key);
    pendingActionsCallIdRef.current.delete(key);
  };
  /** Thread a turn belongs to: parsed from its own session id, so a turn that
   *  overlaps a thread switch still lands in its own thread. */
  const threadForTurn = (sessionId: string | undefined): string | null => {
    if (sessionId?.startsWith("chat-")) return sessionId.slice("chat-".length) || null;
    return threadId;
  };
  const controller = useSessionConversation({
    sessionId: threadId ? `chat-${threadId}` : null,
    acceptUnscopedEvents: true,
    adapter: {
      trackToolCall: (call) => call.name !== "ask_questions",
      onToolCall: (call, sessionId) => {
        // The controller handles ask_questions via the typed question projection;
        // here we only capture suggest_connections' inline action payload.
        if (call.name === "suggest_connections") {
          const key = sessionId ?? "\0unscoped";
          pendingActionsRef.current.set(key, (call.args?.actions ?? []) as SuggestedAction[]);
          pendingActionsCallIdRef.current.set(key, call.callId);
        }
      },
      onToolResult: (result, sessionId) => {
        // A rejected suggest_connections call (e.g. missing action `type`)
        // stages nothing usable — drop its payload so only the model's retry
        // (which overwrites via onToolCall) or nothing renders.
        const key = sessionId ?? "\0unscoped";
        if (
          result.callId !== undefined &&
          result.callId === pendingActionsCallIdRef.current.get(key) &&
          (result.error !== undefined || result.ok === false)
        ) {
          clearStagedActions(sessionId);
        }
      },
      onUsage: (usage) => { if (threadId) setThreadUsage(threadId, usage as never); },
      onTurnEnd: (reason, snapshot, detail, sessionId) => {
        const turnThreadId = threadForTurn(sessionId);
        if (!turnThreadId) return;
        // Surface turn failures (blocked / error / max-tokens) — previously swallowed.
        // `detail` carries the structured failure message (as in AgentChatPane);
        // `reason` alone only ever said "error" and hid the cause.
        if (reason && reason !== "completed" && reason !== "aborted") {
          const msg = detail ? `Turn ended: ${reason} — ${detail}` : `Turn ended: ${reason}`;
          // Don't add empty assistant bubble if we already have text; surface as system notice
          if (!snapshot.text.trim()) {
            addMessage(turnThreadId, "system", msg, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined as never);
          } else {
            // Append reason to assistant reasoning so user sees why it stopped
            addMessage(turnThreadId, "assistant", snapshot.text, snapshot.assistant?.contextRefs as never, snapshot.toolCalls as never, stagedActions(sessionId), snapshot.thought ? `${snapshot.thought}\n\n[${msg}]` : `[${msg}]`, undefined, snapshot.subagents, undefined, undefined, undefined, undefined, snapshot.stats as never);
            clearStagedActions(sessionId);
            return;
          }
        }
        const assistant = snapshot.assistant;
        addMessage(turnThreadId, "assistant", snapshot.text, assistant?.contextRefs as never, snapshot.toolCalls as never, stagedActions(sessionId), snapshot.thought, undefined, snapshot.subagents, undefined, undefined, undefined, undefined, snapshot.stats as never);
        if (assistant?.usage) setThreadUsage(turnThreadId, assistant.usage as never);
        clearStagedActions(sessionId);
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
      personality: req.personality, approvalPolicy: req.approvalPolicy, useSubagents: req.useSubagents, config: req.config,
    }), `chat-${req.threadId}`);
    if (threadId) setThreadUsage(threadId, undefined);
  }

  function stopStream() { controller.stop(); }
  return { ...controller, toolCalls: controller.toolCalls as ChatToolCall[], pendingQuestions: controller.pendingQuestions as PendingQuestion[] | null, sendStream, stopStream };
}
