import type { AgentMessage, ChatMessage } from "@/types";
import type { ConversationMessage } from "./conversation-message";
import { toConversationMessage } from "./conversation-message";

export type SessionMessage = ChatMessage | AgentMessage;

/** Accept the response envelopes used by the chat and native session APIs. */
export function unwrapSessionMessages(value: unknown): SessionMessage[] {
  const raw = value && typeof value === "object" && "data" in value
    ? (value as { data?: unknown }).data
    : value;
  if (Array.isArray(raw)) return raw as SessionMessage[];
  if (raw && typeof raw === "object" && "messages" in raw) {
    const messages = (raw as { messages?: unknown }).messages;
    if (Array.isArray(messages)) return messages as SessionMessage[];
  }
  return [];
}

export function normalizeSessionMessages(value: unknown): ConversationMessage[] {
  // Do not pass toConversationMessage directly: Array#map supplies the item
  // index as its second argument, which this mapper reserves for extraContent.
  return unwrapSessionMessages(value).map((message) => toConversationMessage(message));
}

/** Apply an approval projection without coupling callers to a profile store. */
export function applyApprovalProjection(
  messages: ConversationMessage[],
  data: { callId?: unknown; status?: unknown; nonce?: unknown },
): ConversationMessage[] {
  if (typeof data.callId !== "string") return messages;
  return messages.map((message) => message.role !== "assistant" ? message : {
    ...message,
    toolCalls: message.toolCalls?.map((tool) => tool.callId !== data.callId ? tool : {
      ...tool,
      confirmRequired: data.status === "required",
      approvalNonce: typeof data.nonce === "string" ? data.nonce : undefined,
    }),
  });
}
