import type { AskQuestion } from "@cairn/shared/chat/questions";
import { createPendingSlot } from "./pending-slot";

/**
 * The `ask_questions` card waiting for an answer. The tool's run awaits
 * `askQuestions`, the chat screen renders the card from `usePendingQuestions`,
 * and the card settles it with `answerQuestions` or `skipQuestions`. One card at
 * a time: a new ask settles an older one as skipped.
 */
export interface PendingQuestions {
  id: number;
  questions: AskQuestion[];
}

export type QuestionsOutcome = { answers: Record<string, string> } | { skipped: true };

const slot = createPendingSlot<{ questions: AskQuestion[] }, QuestionsOutcome>({ skipped: true });

/**
 * What has been typed into the open card, kept here rather than in the card so it
 * survives the transcript remounting (iOS remounts it every time the app resumes).
 */
const drafts = new Map<number, Record<string, string>>();
export const getAnswerDraft = (id: number): Record<string, string> => drafts.get(id) ?? {};
export const setAnswerDraft = (id: number, answers: Record<string, string>): void => { drafts.set(id, answers); };

export const askQuestions = (questions: AskQuestion[]): Promise<QuestionsOutcome> => {
  drafts.clear();
  return slot.ask({ questions });
};
export const answerQuestions = (answers: Record<string, string>): boolean => {
  const settled = slot.settle({ answers });
  if (settled) drafts.clear();
  return settled;
};
/** Close the card without answering (Skip, Clear chat, leaving the screen). */
export const skipQuestions = (): boolean => {
  const settled = slot.cancel();
  if (settled) drafts.clear();
  return settled;
};
export const usePendingQuestions: () => PendingQuestions | null = slot.usePending;
