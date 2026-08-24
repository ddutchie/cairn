import type { ReactNode } from "react";
import type { ChatMessage, ChatSubagent, ChatToolCallRecord, LinkedContextReference, PiAgentMessage, PiSubagentMessage, TokenBreakdown } from "@/types";

export interface ConversationToolCall {
  callId?: string;
  name: string;
  label: string;
  args?: Record<string, unknown>;
  running?: boolean;
  ok: boolean;
  output?: string;
  error?: string;
  cairnRef?: { type: "note" | "task"; id: string; title: string };
  externalRef?: { url: string; title?: string; snippet?: string };
  meta?: Record<string, unknown>;
  confirmRequired?: boolean;
  approvalNonce?: string;
}

export interface ConversationMessage {
  id: string;
  role: "user" | "assistant" | "error" | "system";
  content: string;
  reasoning?: string;
  reasoningSummary?: string;
  images?: Array<{ url: string; name: string; kind?: "image" | "pdf" }>;
  toolCalls?: ConversationToolCall[];
  subagents?: unknown[];
  contextRefs?: LinkedContextReference[];
  extraContent?: ReactNode;
  isStreaming?: boolean;
  createdAt: string;
}

export interface ConversationSubagent {
  id: string;
  label: string;
  instruction?: string;
  content?: string;
  result?: string;
  running: boolean;
  toolCalls?: ConversationToolCall[];
  messages?: ConversationMessage[];
  lastUsage?: {
    promptTokens: number;
    completionTokens: number;
    reasoningTokens?: number;
    breakdown?: TokenBreakdown;
    costUsd?: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
  };
}

function parseArgs(args: string | undefined): Record<string, unknown> | undefined {
  if (!args) return undefined;
  try {
    const parsed: unknown = JSON.parse(args);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function chatToolCall(tool: ChatToolCallRecord): ConversationToolCall {
  return {
    callId: tool.callId,
    name: tool.tool,
    label: tool.label,
    args: parseArgs(tool.args),
    ok: tool.ok !== false,
    output: tool.output,
    cairnRef: tool.cairnRef,
    externalRef: tool.externalRef,
    meta: tool.meta,
  };
}

function agentToolCall(tool: NonNullable<PiAgentMessage["toolCalls"]>[number]): ConversationToolCall {
  return { ...tool };
}

export function toConversationToolCall(
  tool: ChatToolCallRecord | NonNullable<PiAgentMessage["toolCalls"]>[number],
): ConversationToolCall {
  return "tool" in tool ? chatToolCall(tool) : agentToolCall(tool);
}

/** Normalize Chat and Coding records before they reach the shared renderer. */
export function toConversationMessage(
  message: ChatMessage | PiAgentMessage,
  extraContent?: ReactNode,
): ConversationMessage {
  const isChat = "threadId" in message;
  const toolCalls = isChat
    ? message.toolCalls?.map(chatToolCall)
    : message.toolCalls?.map(agentToolCall);
  return {
    id: message.id,
    role: message.role,
    content: message.content,
    reasoning: message.reasoning,
    reasoningSummary: isChat ? message.reasoningSummary : undefined,
    images: message.images,
    toolCalls,
    subagents: message.subagents,
    contextRefs: isChat ? message.contextRefs : undefined,
    extraContent,
    isStreaming: isChat ? undefined : message.isStreaming,
    createdAt: isChat ? message.createdAt : message.timestamp,
  };
}

export function toConversationSubagent(
  subagent: ChatSubagent | PiSubagentMessage,
): ConversationSubagent {
  if ("childId" in subagent) {
    return {
      id: subagent.childId,
      label: subagent.role === "research" ? "Research agent" : subagent.role === "write" ? "Writing agent" : subagent.role || "Sub-agent",
      instruction: subagent.instruction,
      content: subagent.content,
      result: subagent.result,
      running: subagent.running,
      toolCalls: subagent.toolCalls?.map(toConversationToolCall),
      lastUsage: subagent.lastUsage,
    };
  }
  return {
    id: subagent.childSessionId,
    label: "Sub-agent",
    result: subagent.result,
    running: subagent.running,
    messages: subagent.messages.map((message) => toConversationMessage(message)),
    lastUsage: subagent.lastUsage,
  };
}
