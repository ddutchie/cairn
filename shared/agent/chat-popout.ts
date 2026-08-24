/** Identity-only contract shared by the Electron handoff and popout route. */
export interface ChatPopoutPayload {
  sessionId: string;
  activeProjectId: string | null;
}

export function bindChatPopoutSession(value: unknown): ChatPopoutPayload | null {
  if (!value || typeof value !== "object") return null;
  const payload = value as Partial<ChatPopoutPayload>;
  if (typeof payload.sessionId !== "string" || payload.sessionId.length === 0) return null;
  if (payload.activeProjectId !== null && typeof payload.activeProjectId !== "string") return null;
  return { sessionId: payload.sessionId, activeProjectId: payload.activeProjectId ?? null };
}
