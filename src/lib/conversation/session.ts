import type { AgentMessage, ChatMessage } from "@/types";
import type { ConversationMessage } from "./message";
import { toConversationMessage } from "./message";

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
 * `{ messages, usage?, todos?, title? }` (preload has already stripped the IPC
 * envelope); a bare array is still accepted. One reader keeps the four call
 * sites recovering the same fields.
 */
export function unwrapSessionPayload(raw: unknown): SessionPayload {
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
  data: { callId?: unknown; status?: unknown; nonce?: unknown; reason?: unknown },
): ConversationMessage[] {
  if (typeof data.callId !== "string") return messages;
  return messages.map((message) => message.role !== "assistant" ? message : {
    ...message,
    toolCalls: message.toolCalls?.map((tool) => tool.callId !== data.callId ? tool : {
      ...tool,
      confirmRequired: data.status === "required",
      approvalNonce: typeof data.nonce === "string" ? data.nonce : undefined,
      approvalReason: typeof data.reason === "string" ? data.reason : undefined,
    }),
  });
}
