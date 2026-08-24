/** Shared answer broker for every Cordis session surface. */
export interface PendingQuestionRecord {
  sessionId: string;
  callId: string;
  questions: Array<{ id: string; [key: string]: unknown }>;
}

const pendingQuestions = new Map<string, { resolve: (answersText: string) => void; record?: PendingQuestionRecord }>();

const key = (sessionId: string, callId: string) => `${sessionId}::${callId}`;

export function registerPendingQuestion(
  sessionId: string,
  callId: string,
  resolve: (answersText: string) => void,
): () => void {
  const pendingKey = key(sessionId, callId);
  pendingQuestions.set(pendingKey, { resolve, record: pendingQuestions.get(pendingKey)?.record });
  return () => pendingQuestions.delete(pendingKey);
}

export function resolvePendingQuestionAnswer(sessionId: string, callId: string, answers: string): boolean {
  const pendingKey = key(sessionId, callId);
  const pending = pendingQuestions.get(pendingKey);
  if (!pending) return false;
  pending.resolve(answers);
  pendingQuestions.delete(pendingKey);
  return true;
}

/** Keep recovery metadata beside the resolver in the same session-scoped broker. */
export function recordPendingQuestion(record: PendingQuestionRecord): void {
  const pendingKey = key(record.sessionId, record.callId);
  const existing = pendingQuestions.get(pendingKey);
  if (existing) existing.record = record;
  else pendingQuestions.set(pendingKey, { resolve: () => {}, record });
}

export function listPendingQuestions(sessionId: string): PendingQuestionRecord[] {
  const prefix = `${sessionId}::`;
  return Array.from(pendingQuestions.values())
    .map((entry) => entry.record)
    .filter((record): record is PendingQuestionRecord => record !== undefined && record.sessionId + "::" === prefix);
}

export function clearPendingQuestions(sessionId: string): void {
  const prefix = `${sessionId}::`;
  for (const pendingKey of Array.from(pendingQuestions.keys())) {
    if (pendingKey.startsWith(prefix)) pendingQuestions.delete(pendingKey);
  }
}
