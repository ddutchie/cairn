/**
 * Outstanding `ask_questions` cards. (F5/B4: split out of
 * `electron/ipc/engine-bridge.ts`; no logic changes.)
 */
import { pendingQuestions, qKey } from "./session-state";

export function answerQuestion(sessionId: string, callId: string, nonce: string | undefined, answers: string): boolean {
  const pending = pendingQuestions.get(qKey(sessionId, callId));
  if (!pending || !nonce || pending.nonce !== nonce) return false;
  pendingQuestions.delete(qKey(sessionId, callId));
  pending.resolve(answers);
  return true;
}

/** Outstanding question asks, so a reloading renderer can re-open the card. */
export function listPendingQuestions(sessionId: string): Array<{ callId: string; questions: never; nonce: string }> {
  const prefix = `${sessionId}::`;
  return [...pendingQuestions].filter(([k]) => k.startsWith(prefix)).map(([k, p]) => ({ callId: k.slice(prefix.length), questions: p.questions as never, nonce: p.nonce }));
}

export function cancelQuestions(sessionId: string): void {
  for (const [key, p] of [...pendingQuestions]) {
    if (key.startsWith(`${sessionId}::`)) { pendingQuestions.delete(key); p.reject(new Error("cancelled")); }
  }
}
