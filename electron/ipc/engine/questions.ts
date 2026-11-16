/**
 * Outstanding `ask_questions` cards. (F5/B4: split out of
 * `electron/ipc/engine-bridge.ts`; state now lives in `session-state.ts`.)
 */
import { ensureSessionState, getSessionState } from "./session-state";

export function answerQuestion(sessionId: string, callId: string, nonce: string | undefined, answers: string): boolean {
  const st = getSessionState(sessionId);
  const pending = st?.questions.get(callId);
  if (!st || !pending || !nonce || pending.nonce !== nonce) return false;
  st.questions.delete(callId);
  pending.resolve(answers);
  return true;
}

/** Outstanding question asks, so a reloading renderer can re-open the card. */
export function listPendingQuestions(sessionId: string): Array<{ callId: string; questions: never; nonce: string }> {
  const st = getSessionState(sessionId);
  if (!st) return [];
  return [...st.questions].map(([callId, p]) => ({ callId, questions: p.questions as never, nonce: p.nonce }));
}

export function cancelQuestions(sessionId: string): void {
  const st = getSessionState(sessionId);
  if (!st) return;
  for (const [callId, p] of [...st.questions]) {
    st.questions.delete(callId);
    p.reject(new Error("cancelled"));
  }
}

/** Queue an `ask_questions` card for a live tool call. */
export function askSessionQuestion(sessionId: string, callId: string, nonce: string, questions: unknown, resolve: (answers: string) => void, reject: (err: Error) => void): void {
  ensureSessionState(sessionId).questions.set(callId, { nonce, questions, resolve, reject });
}

/** Withdraw a card, resolving `true` when one was waiting. */
export function takeSessionQuestion(sessionId: string, callId: string): boolean {
  return getSessionState(sessionId)?.questions.delete(callId) ?? false;
}
