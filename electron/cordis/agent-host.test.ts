import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getContext: vi.fn(),
  readGoalSnapshot: vi.fn(),
  putMessageFeedback: vi.fn(),
  getMessageFeedback: vi.fn(),
  listSchedules: vi.fn(),
  openCordisAgent: vi.fn(),
  ensureAgentAiAdapter: vi.fn(),
  getPlanModeActive: vi.fn(),
  readPermissionsSnapshot: vi.fn(),
  loadSessionMessages: vi.fn(),
  prepareReplayContext: vi.fn(),
  readSessionStatsSnapshot: vi.fn(),
  compactNow: vi.fn(),
  whenIdle: vi.fn(),
  dispose: vi.fn(),
  deleteAgent: vi.fn(),
  getAgent: vi.fn(),
  runOneShotWithContext: vi.fn(),
  readContextRingWithContext: vi.fn(),
  listSubagentChildrenWithContext: vi.fn(),
  interruptSubagentChildWithContext: vi.fn(),
  messageSubagentChildWithContext: vi.fn(),
  resolvePendingQuestionAnswer: vi.fn(),
  clearPendingQuestions: vi.fn(),
  getSessionGrants: vi.fn(),
  clearSessionGrants: vi.fn(),
  clearSecretGrants: vi.fn(),
  canonicalBashCommand: vi.fn(),
  createPendingAskRegistry: vi.fn(() => ({ record: vi.fn(), resolve: vi.fn(), listForSession: vi.fn(() => []), clearSession: vi.fn() })),
}));

vi.mock("./cordis-context", () => ({ getContext: mocks.getContext }));
vi.mock("./goal-bridge", () => ({ readGoalSnapshot: mocks.readGoalSnapshot }));
vi.mock("./message-feedback", () => ({
  putMessageFeedback: mocks.putMessageFeedback,
  getMessageFeedback: mocks.getMessageFeedback,
}));
vi.mock("./schedule-read", () => ({ listSchedules: mocks.listSchedules }));
vi.mock("./run-cordis-coding", () => ({ openCordisAgent: mocks.openCordisAgent }));
vi.mock("./session-runtime", () => ({ ensureAgentAiAdapter: mocks.ensureAgentAiAdapter }));
vi.mock("./plan-fold", () => ({ getPlanModeActive: mocks.getPlanModeActive }));
vi.mock("./permissions-bridge", () => ({ readPermissionsSnapshot: mocks.readPermissionsSnapshot }));
vi.mock("./session-replay", () => ({ loadSessionMessages: mocks.loadSessionMessages }));
vi.mock("./run-cordis-loop", () => ({ prepareReplayContext: mocks.prepareReplayContext, readContextRingWithContext: mocks.readContextRingWithContext }));
vi.mock("./session-stats", () => ({ readSessionStatsSnapshot: mocks.readSessionStatsSnapshot }));
vi.mock("./one-shot", () => ({ runOneShotWithContext: mocks.runOneShotWithContext }));
vi.mock("./subagent-control", () => ({
  listSubagentChildrenWithContext: mocks.listSubagentChildrenWithContext,
  interruptSubagentChildWithContext: mocks.interruptSubagentChildWithContext,
  messageSubagentChildWithContext: mocks.messageSubagentChildWithContext,
}));
vi.mock("./pending-question-broker", () => ({
  resolvePendingQuestionAnswer: mocks.resolvePendingQuestionAnswer,
  clearPendingQuestions: mocks.clearPendingQuestions,
}));
vi.mock("./approval-grants", () => ({
  getSessionGrants: mocks.getSessionGrants,
  clearSessionGrants: mocks.clearSessionGrants,
  canonicalBashCommand: mocks.canonicalBashCommand,
  createPendingAskRegistry: mocks.createPendingAskRegistry,
}));
vi.mock("./secret-grants", () => ({ clearSecretGrants: mocks.clearSecretGrants }));

import { getAgentHost } from "./agent-host";

const context = { marker: "context", compaction: undefined as unknown };

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

  it("loads shared session messages and permissions through the host", async () => {
    const persistence = { inspect: vi.fn() };
    const list = vi.fn().mockReturnValue([]);
    const get = vi.fn();
    const contextWithSessionData = {
      ...context,
      sessionPersistence: persistence,
      sessions: { list, get },
      sessionProjections: {},
    };
    const permissions = { options: [{ value: "default", name: "Default" }], currentValue: "default" };
    const messages = { messages: [], subagents: [] };
    mocks.getContext.mockResolvedValue(contextWithSessionData);
    mocks.readPermissionsSnapshot.mockResolvedValue(permissions);
    mocks.prepareReplayContext.mockResolvedValue(undefined);
    mocks.readSessionStatsSnapshot.mockReturnValue(undefined);
    mocks.loadSessionMessages.mockResolvedValue(messages);

    await expect(getAgentHost().readPermissionsSnapshot("session-1")).resolves.toBe(permissions);
    await expect(getAgentHost().loadSessionMessages("session-1")).resolves.toBe(messages);

    expect(mocks.readPermissionsSnapshot).toHaveBeenCalledWith(contextWithSessionData, "session-1");
    expect(mocks.prepareReplayContext).toHaveBeenCalledWith(persistence, "session-1");
    expect(mocks.readSessionStatsSnapshot).toHaveBeenCalledWith(contextWithSessionData.sessionProjections, undefined);
    expect(mocks.loadSessionMessages).toHaveBeenCalledWith(persistence, expect.any(Function), "session-1", undefined);
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

  it("compacts sessions through the host and disposes the temporary agent", async () => {
    const agent = { whenIdle: mocks.whenIdle, session: {} };
    mocks.ensureAgentAiAdapter.mockResolvedValue(undefined);
    mocks.openCordisAgent.mockResolvedValue({ agent, dispose: mocks.dispose });
    mocks.whenIdle.mockResolvedValue(undefined);
    mocks.compactNow.mockResolvedValue({ replacedSeqs: [1, 2], summary: "summary" });
    context.compaction = { compactNow: mocks.compactNow };

    const result = await getAgentHost().compactSession({
      sessionId: "session-1",
      cwd: "/workspace",
      baseUrl: "https://api.openai.com",
      model: "model-1",
      apiKey: "key-1",
      apiMode: "responses",
    });

    expect(result).toEqual({ messageCount: 2, summary: "summary" });
    expect(mocks.ensureAgentAiAdapter).toHaveBeenCalledWith(context, {
      baseUrl: "https://api.openai.com",
      model: "model-1",
      apiKey: "key-1",
      api: "openai-responses",
    });
    expect(mocks.openCordisAgent).toHaveBeenCalledWith(context, expect.objectContaining({
      sessionId: "session-1",
      cwd: "/workspace",
      llmConfig: expect.objectContaining({ apiMode: "responses" }),
    }));
    expect(mocks.whenIdle).toHaveBeenCalledOnce();
    expect(mocks.dispose).toHaveBeenCalledOnce();
  });

  it("executes plan commands through the host", async () => {
    const execute = vi.fn().mockResolvedValue({ result: { kind: "success" } });
    const agent = { session: {} };
    const contextWithCommands = { ...context, commands: { execute } };
    mocks.getContext.mockResolvedValue(contextWithCommands);
    mocks.openCordisAgent.mockResolvedValue({ agent, dispose: mocks.dispose });
    mocks.getPlanModeActive.mockReturnValue(true);

    await expect(getAgentHost().setSessionMode({
      sessionId: "session-1",
      cwd: "/workspace",
      baseUrl: "https://api.openai.com",
      model: "model-1",
      apiKey: "key-1",
      mode: "plan",
    })).resolves.toBe("plan");

    expect(execute).toHaveBeenCalledWith(agent, "/plan", [], expect.any(AbortSignal));
    expect(mocks.getPlanModeActive).toHaveBeenCalledWith(contextWithCommands, agent.session);
    expect(mocks.dispose).toHaveBeenCalledOnce();
  });

  it("routes subagent controls through the host", async () => {
    const catalog = { entries: [], parentAvailable: true };
    const signal = new AbortController().signal;
    mocks.listSubagentChildrenWithContext.mockResolvedValue(catalog);
    mocks.interruptSubagentChildWithContext.mockResolvedValue({ accepted: true });
    mocks.messageSubagentChildWithContext.mockResolvedValue({ messageId: "message-1" });

    await expect(getAgentHost().listSubagentChildren("parent-1", "descendants", signal)).resolves.toBe(catalog);
    await expect(getAgentHost().interruptSubagentChild("parent-1", "child-1")).resolves.toEqual({ accepted: true });
    await expect(getAgentHost().messageSubagentChild("parent-1", "child-1", "hello", signal)).resolves.toEqual({ messageId: "message-1" });

    expect(mocks.listSubagentChildrenWithContext).toHaveBeenCalledWith(context, "parent-1", "descendants", signal);
    expect(mocks.interruptSubagentChildWithContext).toHaveBeenCalledWith(context, "parent-1", "child-1");
    expect(mocks.messageSubagentChildWithContext).toHaveBeenCalledWith(context, "parent-1", "child-1", "hello", signal);
  });

  it("reads context-ring state through the host", async () => {
    const result = { available: true, ring: { currentModel: "model-1", byModel: {} } };
    mocks.readContextRingWithContext.mockResolvedValue(result);

    await expect(getAgentHost().readContextRing("session-1")).resolves.toBe(result);

    expect(mocks.readContextRingWithContext).toHaveBeenCalledWith(context, "session-1");
  });

  it("routes approval resolvers and nonces through the host", () => {
    const decisions: unknown[] = [];
    getAgentHost().registerPendingApproval("session-1", "call-1", (decision) => decisions.push(decision));
    const nonce = getAgentHost().mintApprovalNonce("session-1", "call-1");

    expect(getAgentHost().verifyApprovalNonce("session-1", "call-1", nonce)).toBe(true);
    expect(getAgentHost().verifyApprovalNonce("session-1", "call-1", "wrong")).toBe(false);
    expect(getAgentHost().resolvePendingApproval("session-1", "call-1", { approved: true, grant: "session" })).toBe(true);
    expect(decisions).toEqual([{ approved: true, grant: "session" }]);
    expect(getAgentHost().resolvePendingApproval("session-1", "call-1", { approved: false })).toBe(false);
    getAgentHost().clearApprovalState("session-1");
    expect(getAgentHost().verifyApprovalNonce("session-1", "call-1", nonce)).toBe(false);
  });

  it("routes pending question state through the host", () => {
    mocks.resolvePendingQuestionAnswer.mockReturnValue(true);

    expect(getAgentHost().respondToQuestion("session-1", "call-1", "answer")).toBe(true);
    getAgentHost().clearSessionQuestions("session-1");

    expect(mocks.resolvePendingQuestionAnswer).toHaveBeenCalledWith("session-1", "call-1", "answer");
    expect(mocks.clearPendingQuestions).toHaveBeenCalledWith("session-1");
  });

  it("routes session approval grants through the host", () => {
    const grants = { tools: new Set<string>(), bashCommands: new Set<string>() };
    mocks.getSessionGrants.mockReturnValue(grants);
    mocks.canonicalBashCommand.mockReturnValue("echo ok");

    getAgentHost().grantSessionBash("session-1", " echo   ok ");
    getAgentHost().grantSessionTool("session-1", "read_file");
    getAgentHost().clearSessionApprovalState("session-1");

    expect(grants.bashCommands).toEqual(new Set(["echo ok"]));
    expect(grants.tools).toEqual(new Set(["read_file"]));
    expect(mocks.clearSessionGrants).toHaveBeenCalledWith("session-1");
    expect(mocks.clearSecretGrants).toHaveBeenCalledWith("session-1");
  });

  it("runs one-shot AI with the host context", async () => {
    const options = { systemPrompt: "system", userPrompt: "user", config: { baseUrl: "https://api.openai.com", model: "model-1", apiKey: "key-1" }, source: "test" };
    mocks.runOneShotWithContext.mockResolvedValue("result");

    await expect(getAgentHost().runOneShot(options)).resolves.toBe("result");

    expect(mocks.runOneShotWithContext).toHaveBeenCalledWith(context, options);
    expect(mocks.getContext).toHaveBeenCalledOnce();
  });

  it("releases a resident session agent best-effort", async () => {
    const contextWithAgents = { ...context, agents: { delete: mocks.deleteAgent } };
    mocks.getContext.mockResolvedValue(contextWithAgents);

    await getAgentHost().releaseSessionAgent("session-1");

    expect(mocks.deleteAgent).toHaveBeenCalledWith(expect.objectContaining({ toString: expect.any(Function) }));
  });
});
