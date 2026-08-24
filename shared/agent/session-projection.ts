/** Typed, non-durable UI projections for a Cairn agent session. */

export type SessionProjectionKind =
  | "token" | "thought" | "tool" | "done" | "error" | "usage"
  | "approval" | "question" | "subagent-trace" | "todos" | "plan-note"
  | "mode-change" | "note-updated" | "retry" | "compact" | "compact-result"
  | "tools-ready" | "step";

export type SessionProjectionData = {
  token: { delta: string };
  thought: { delta: string };
  tool: Record<string, unknown>;
  done: Record<string, unknown>;
  error: { error: string };
  usage: Record<string, unknown>;
  approval: Record<string, unknown>;
  question: { callId: string; questions: unknown[] };
  "subagent-trace": Record<string, unknown>;
  todos: { todos: unknown[] };
  "plan-note": { noteId?: string; planContent?: string };
  "mode-change": { mode: "plan" | "execute"; planNoteId?: string };
  "note-updated": { noteId: string; content: string };
  retry: { attempt: number; maxRetries: number; delayMs: number; error: string };
  compact: { status: "start" | "end"; auto?: boolean };
  "compact-result": { messageCount: number; summary: string };
  "tools-ready": Record<string, never>;
  step: Record<string, never>;
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
