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

export const askQuestions = (questions: AskQuestion[]): Promise<QuestionsOutcome> => slot.ask({ questions });
export const answerQuestions = (answers: Record<string, string>): boolean => slot.settle({ answers });
/** Close the card without answering (Skip, Clear chat, leaving the screen). */
export const skipQuestions = (): boolean => slot.cancel();
export const usePendingQuestions: () => PendingQuestions | null = slot.usePending;
