import type { AgentMessage, ChatMessage } from "@/types";
import type { ConversationMessage } from "./conversation-message";
import { toConversationMessage } from "./conversation-message";

export type SessionMessage = ChatMessage | AgentMessage;

/** Sidecar fields the session-history IPC returns alongside the transcript. */
export interface SessionPayload {
  messages: SessionMessage[];
  usage?: unknown;
  todos?: Array<{ id: string; title: string; status: "pending" | "in_progress" | "completed" }>;
  title?: string | null;
}

/**
 * Unwrap a session-history response into its parts.
 *
 * Both history channels (`db:chat:sessionMessages`, `db:session:messages`) return
 * one of three shapes — a bare array, `{messages, usage, todos}`, or either of
 * those behind an ipc `{data}` envelope. Four call sites each open-coded this
 * ladder, and they had drifted: some handled the `{data}` wrapper, some didn't,
 * and only two recovered `usage`. One unwrapper keeps them honest.
 */
export function unwrapSessionPayload(value: unknown): SessionPayload {
  const raw = value && typeof value === "object" && "data" in value && (value as { data?: unknown }).data !== undefined
    ? (value as { data: unknown }).data
    : value;
  if (Array.isArray(raw)) return { messages: raw as SessionMessage[] };
  if (raw && typeof raw === "object") {
    const record = raw as { messages?: unknown; usage?: unknown; todos?: unknown; title?: unknown };
    if (Array.isArray(record.messages)) {
      return {
        messages: record.messages as SessionMessage[],
        usage: record.usage,
        todos: Array.isArray(record.todos) ? record.todos as SessionPayload["todos"] : undefined,
        title: typeof record.title === "string" && record.title.trim() ? record.title : (record.title === null ? null : undefined),
      };
    }
  }
  return { messages: [] };
}

/** Accept the response envelopes used by the chat and native session APIs. */
export function unwrapSessionMessages(value: unknown): SessionMessage[] {
  return unwrapSessionPayload(value).messages;
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
