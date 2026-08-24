/** Stable identity conversion used by the Chat surface and its pop-out. */
export function chatSessionId(threadId: string): string {
  return `chat-${threadId}`;
}

export function chatThreadId(sessionId: string): string {
  return sessionId.startsWith("chat-") ? sessionId.slice("chat-".length) : sessionId;
}
