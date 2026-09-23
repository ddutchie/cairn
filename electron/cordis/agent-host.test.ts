import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getContext: vi.fn(),
  readGoalSnapshot: vi.fn(),
  putMessageFeedback: vi.fn(),
  getMessageFeedback: vi.fn(),
  listSchedules: vi.fn(),
}));

vi.mock("./cordis-context", () => ({ getContext: mocks.getContext }));
vi.mock("./goal-bridge", () => ({ readGoalSnapshot: mocks.readGoalSnapshot }));
vi.mock("./message-feedback", () => ({
  putMessageFeedback: mocks.putMessageFeedback,
  getMessageFeedback: mocks.getMessageFeedback,
}));
vi.mock("./schedule-read", () => ({ listSchedules: mocks.listSchedules }));

import { getAgentHost } from "./agent-host";

const context = { marker: "context" };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getContext.mockResolvedValue(context);
});

describe("AgentHost", () => {
  it("resolves the shared context for goal reads", async () => {
    const goal = { id: "goal-1" };
    mocks.readGoalSnapshot.mockResolvedValue(goal);

    await expect(getAgentHost().readGoalSnapshot("session-1")).resolves.toBe(goal);
    expect(mocks.getContext).toHaveBeenCalledOnce();
    expect(mocks.readGoalSnapshot).toHaveBeenCalledWith(context, "session-1");
  });

  it("routes message feedback and schedule reads through the same host", async () => {
    const input = { sessionId: "session-1", messageId: "message-1", rating: "positive" as const };
    mocks.putMessageFeedback.mockResolvedValue({ messageId: "message-1" });
    mocks.getMessageFeedback.mockResolvedValue(null);
    mocks.listSchedules.mockResolvedValue([]);

    await getAgentHost().putMessageFeedback(input);
    await getAgentHost().getMessageFeedback("session-1", "message-1");
    await getAgentHost().listSchedules("session-1");

    expect(mocks.putMessageFeedback).toHaveBeenCalledWith(context, input);
    expect(mocks.getMessageFeedback).toHaveBeenCalledWith(context, "session-1", "message-1");
    expect(mocks.listSchedules).toHaveBeenCalledWith(context, "session-1");
    expect(mocks.getContext).toHaveBeenCalledTimes(3);
  });
});
