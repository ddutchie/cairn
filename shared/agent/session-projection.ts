/** Typed, non-durable UI projections for a Cairn agent session. */

export type SessionProjectionKind =
  | "approval" | "question" | "subagent-trace" | "todos" | "plan-note"
  | "mode-change" | "note-updated" | "retry" | "compact" | "compact-result" | "error";

/**
 * Shared busy/error envelope for session:* channels.
 * Both `session:projection` error.code and `session:busy` reason use this
 * union so the renderer can match on one type without mapping. `busy` is
 * the legacy alias for `already-running` (kept for backwards compat — new
 * code prefers `already-running`).
 */
export type SessionBusyReason =
  | "already-running"
  | "busy"
  | "unknown-profile"
  | "localllm-disabled"
  | "missing-api-key"
  | "invalid-attachment"
  | "invalid-id";

/** Convenience: session:busy payload (reused for typing busy handlers). */
export type SessionBusyPayload = { sessionId: string; reason: SessionBusyReason; message?: string };

export type SessionProjectionData = {
  approval: Record<string, unknown>;
  question: { callId: string; questions: unknown[]; nonce?: string };
  "subagent-trace": Record<string, unknown>;
  todos: { todos: unknown[] };
  "plan-note": { noteId?: string; planContent?: string };
  "mode-change": { mode: "plan" | "execute"; planNoteId?: string };
  "note-updated": { noteId: string; content: string };
  retry: { attempt: number; maxRetries: number; delayMs: number; error: string };
  compact: { status: "start" | "end"; auto?: boolean };
  "compact-result": { messageCount: number; summary: string };
  error: { message: string; code?: SessionBusyReason | string };
};

export type SessionProjection<K extends SessionProjectionKind = SessionProjectionKind> = {
  [P in K]: { sessionId: string; kind: P; data: SessionProjectionData[P] };
}[K];

export function makeSessionProjection<K extends SessionProjectionKind>(
  sessionId: string,
  kind: K,
  data: SessionProjectionData[K],
): SessionProjection<K> {
  return { sessionId, kind, data } as SessionProjection<K>;
}

export type SessionProjectionHandlers<R = void> = {
  [K in SessionProjectionKind]?: (data: SessionProjectionData[K], projection: SessionProjection<K>) => R;
};

/** Dispatches a projection without coupling consumers to the transport channel. */
export function dispatchSessionProjection<R = void>(
  projection: SessionProjection,
  handlers: SessionProjectionHandlers<R>,
): R | undefined {
  const handler = handlers[projection.kind] as ((data: unknown, projection: SessionProjection) => R) | undefined;
  return handler?.(projection.data, projection);
}
