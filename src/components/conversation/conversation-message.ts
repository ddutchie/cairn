import type { ReactNode } from "react";
import type { ChatMessage, ChatToolCallRecord, LinkedContextReference, PiAgentMessage } from "@/types";

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
