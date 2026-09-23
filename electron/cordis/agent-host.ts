import type { Context } from "@deepseek-ai/cordis";
import { getContext } from "./cordis-context";
import { readGoalSnapshot, type GoalWire } from "./goal-bridge";
import {
  getMessageFeedback,
  putMessageFeedback,
  type MessageFeedbackItemWire,
  type PutMessageFeedbackInput,
} from "./message-feedback";
import { listSchedules, type ScheduleWire } from "./schedule-read";

export interface AgentHost {
  readGoalSnapshot(sessionId: string): Promise<GoalWire | null>;
  putMessageFeedback(input: PutMessageFeedbackInput): Promise<MessageFeedbackItemWire>;
  getMessageFeedback(sessionId: string, messageId: string): Promise<MessageFeedbackItemWire | null>;
  listSchedules(sessionId: string): Promise<ScheduleWire[]>;
}

function createLocalAgentHost(): AgentHost {
  const context = (): Promise<Context> => getContext();

  return {
    async readGoalSnapshot(sessionId) {
      return readGoalSnapshot(await context(), sessionId);
    },
    async putMessageFeedback(input) {
      return putMessageFeedback(await context(), input);
    },
    async getMessageFeedback(sessionId, messageId) {
      return getMessageFeedback(await context(), sessionId, messageId);
    },
    async listSchedules(sessionId) {
      return listSchedules(await context(), sessionId);
    },
  };
}

const localAgentHost = createLocalAgentHost();

export function getAgentHost(): AgentHost {
  return localAgentHost;
}
