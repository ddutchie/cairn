import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getContext: vi.fn(),
  getSessionRoot: vi.fn(() => "/tmp/sessions"),
  setSessionRoot: vi.fn(),
  shutdownContext: vi.fn(),
  dropChatAgentForThread: vi.fn(),
  readGoalSnapshot: vi.fn(),
  putMessageFeedback: vi.fn(),
  getMessageFeedback: vi.fn(),
  listSchedules: vi.fn(),
  openCordisAgent: vi.fn(),
  runCordisCodingLoop: vi.fn(),
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
  registerPendingQuestion: vi.fn(),
  recordPendingQuestion: vi.fn(),
  listPendingQuestions: vi.fn((): PendingQuestionRecord[] => []),
  clearPendingQuestions: vi.fn(),
  clearAllPendingQuestions: vi.fn(),
  getSessionGrants: vi.fn(),
  readPendingApprovalArgs: vi.fn(),
  forgetPendingApprovalArgs: vi.fn(),
  forgetSessionApprovalArgs: vi.fn(),
  clearSessionGrants: vi.fn(),
  clearSecretGrants: vi.fn(),
  clearAllSecretGrants: vi.fn(),
  clearAllSessionGrants: vi.fn(),
  clearAllApprovalState: vi.fn(),
  canonicalBashCommand: vi.fn(),
  createPendingAskRegistry: vi.fn(() => ({ record: vi.fn(), resolve: vi.fn(), listForSession: vi.fn(() => []), clearSession: vi.fn(), clearAll: vi.fn() })),
  setPluginsRoot: vi.fn(),
  getPluginsRoot: vi.fn(() => "/tmp/plugins"),
  stopWatchingUserPlugins: vi.fn(),
  installPlugin: vi.fn(),
  updatePlugin: vi.fn(),
  uninstallPlugin: vi.fn(),
  createInteractiveConfirmTransport: vi.fn(),
  createHeadlessConfirmTransport: vi.fn(),
  setConfirmTransport: vi.fn(),
  clearAllConfirmTransports: vi.fn(),
  killJob: vi.fn(),
}));

vi.mock("./cordis-context", () => ({ getContext: mocks.getContext, getSessionRoot: mocks.getSessionRoot, setSessionRoot: mocks.setSessionRoot, shutdownContext: mocks.shutdownContext, dropChatAgentForThread: mocks.dropChatAgentForThread }));
vi.mock("./goal-bridge", () => ({ readGoalSnapshot: mocks.readGoalSnapshot }));
vi.mock("./message-feedback", () => ({
  putMessageFeedback: mocks.putMessageFeedback,
  getMessageFeedback: mocks.getMessageFeedback,
}));
vi.mock("./schedule-read", () => ({ listSchedules: mocks.listSchedules }));
vi.mock("./run-cordis-coding", () => ({ openCordisAgent: mocks.openCordisAgent, runCordisCodingLoop: mocks.runCordisCodingLoop }));
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
  registerPendingQuestion: mocks.registerPendingQuestion,
  recordPendingQuestion: mocks.recordPendingQuestion,
  listPendingQuestions: mocks.listPendingQuestions,
  clearPendingQuestions: mocks.clearPendingQuestions,
  clearAllPendingQuestions: mocks.clearAllPendingQuestions,
}));
vi.mock("./approval-grants", () => ({
  getSessionGrants: mocks.getSessionGrants,
  clearSessionGrants: mocks.clearSessionGrants,
  clearAllSessionGrants: mocks.clearAllSessionGrants,
  canonicalBashCommand: mocks.canonicalBashCommand,
  readPendingApprovalArgs: mocks.readPendingApprovalArgs,
  forgetPendingApprovalArgs: mocks.forgetPendingApprovalArgs,
  forgetSessionApprovalArgs: mocks.forgetSessionApprovalArgs,
  createPendingAskRegistry: mocks.createPendingAskRegistry,
}));
vi.mock("./approval-transports", () => ({
  clearAllConfirmTransports: mocks.clearAllConfirmTransports,
  createInteractiveConfirmTransport: mocks.createInteractiveConfirmTransport,
  createHeadlessConfirmTransport: mocks.createHeadlessConfirmTransport,
  setConfirmTransport: mocks.setConfirmTransport,
}));
vi.mock("./jobs-bridge", () => ({ killJob: mocks.killJob }));
vi.mock("./secret-grants", () => ({ clearSecretGrants: mocks.clearSecretGrants, clearAllSecretGrants: mocks.clearAllSecretGrants }));
vi.mock("./plugin-loader", () => ({
  setPluginsRoot: mocks.setPluginsRoot,
  getPluginsRoot: mocks.getPluginsRoot,
  stopWatchingUserPlugins: mocks.stopWatchingUserPlugins,
}));
vi.mock("./plugin-installer", () => ({
  installPlugin: mocks.installPlugin,
  updatePlugin: mocks.updatePlugin,
  uninstallPlugin: mocks.uninstallPlugin,
}));

import { getAgentHost } from "./agent-host";
import type { PendingQuestionRecord } from "./pending-question-broker";

const context = { marker: "context", compaction: undefined as unknown };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getContext.mockResolvedValue(context);
});

describe("AgentHost", () => {
  it("routes plugin lifecycle operations through the host", async () => {
    const installed = { id: "demo", name: null, ui: null, kind: "backend" as const };
    mocks.installPlugin.mockResolvedValue(installed);
    mocks.updatePlugin.mockResolvedValue(installed);
    mocks.uninstallPlugin.mockReturnValue(undefined);

    const host = getAgentHost();
    await expect(host.installPlugin("github:owner/demo")).resolves.toEqual(installed);
    await expect(host.updatePlugin("demo")).resolves.toEqual(installed);
    expect(() => host.uninstallPlugin("demo")).not.toThrow();

    expect(mocks.installPlugin).toHaveBeenCalledWith("github:owner/demo");
    expect(mocks.updatePlugin).toHaveBeenCalledWith("demo");
    expect(mocks.uninstallPlugin).toHaveBeenCalledWith("demo");
  });

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

  it("owns turn abort and running state", () => {
    const controller = getAgentHost().startTurn("session-1");

    expect(getAgentHost().isTurnRunning("session-1")).toBe(true);
    expect(getAgentHost().getRunningTurnIds()).toContain("session-1");
    getAgentHost().abortTurn("session-1");
    expect(controller.signal.aborted).toBe(true);
    expect(getAgentHost().isTurnRunning("session-1")).toBe(false);
  });

  it("ignores endTurn from a superseded controller", () => {
    const stale = getAgentHost().startTurn("session-stale");
    const live = getAgentHost().startTurn("session-stale");

    expect(stale.signal.aborted).toBe(true);
    getAgentHost().endTurn("session-stale", stale);
    expect(getAgentHost().isTurnRunning("session-stale")).toBe(true);
    getAgentHost().endTurn("session-stale", live);
    expect(getAgentHost().isTurnRunning("session-stale")).toBe(false);
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

  it("configures runtime roots through the host", () => {
    getAgentHost().configureSessionRoot("/tmp/sessions");
    getAgentHost().configurePluginsRoot("/tmp/plugins");

    expect(mocks.setSessionRoot).toHaveBeenCalledWith("/tmp/sessions");
    expect(mocks.setPluginsRoot).toHaveBeenCalledWith("/tmp/plugins");
    expect(getAgentHost().getSessionRoot()).toBe("/tmp/sessions");
    expect(getAgentHost().getPluginsRoot()).toBe("/tmp/plugins");
  });

  it("routes trusted approval args through the host", () => {
    mocks.readPendingApprovalArgs.mockReturnValue({ command: "echo hi" });
    mocks.canonicalBashCommand.mockImplementation((cmd: unknown) =>
      typeof cmd === "string" ? cmd.trim().replace(/\s+/g, " ") || null : null,
    );

    expect(getAgentHost().readPendingApprovalArgs("session-1", "call-1")).toEqual({ command: "echo hi" });
    expect(getAgentHost().readTrustedBashCommand("session-1", "call-1")).toBe("echo hi");
    getAgentHost().forgetPendingApprovalArgs("session-1", "call-1");
    getAgentHost().forgetSessionApprovalArgs("session-1");

    expect(mocks.readPendingApprovalArgs).toHaveBeenCalledWith("session-1", "call-1");
    expect(mocks.forgetPendingApprovalArgs).toHaveBeenCalledWith("session-1", "call-1");
    expect(mocks.forgetSessionApprovalArgs).toHaveBeenCalledWith("session-1");
  });

  it("routes question broker reads and writes through the host", () => {
    const record = { sessionId: "session-1", callId: "call-1", questions: [{ id: "q1" }] };
    const resolve = vi.fn();
    mocks.listPendingQuestions.mockReturnValue([record]);
    mocks.registerPendingQuestion.mockReturnValue(() => {});

    getAgentHost().recordPendingQuestion(record);
    expect(getAgentHost().listPendingQuestions("session-1")).toEqual([record]);
    getAgentHost().registerPendingQuestion("session-1", "call-1", resolve);

    expect(mocks.recordPendingQuestion).toHaveBeenCalledWith(record);
    expect(mocks.listPendingQuestions).toHaveBeenCalledWith("session-1");
    expect(mocks.registerPendingQuestion).toHaveBeenCalledWith("session-1", "call-1", resolve);
  });

  it("binds and unbinds confirm transports through the host", () => {
    const interactive = { send: vi.fn(), registerPending: vi.fn() };
    const headless = { emitApproval: vi.fn(), registerPending: vi.fn() };
    const transport = { confirm: vi.fn() };
    mocks.createInteractiveConfirmTransport.mockReturnValue(transport);
    mocks.createHeadlessConfirmTransport.mockReturnValue(transport);

    getAgentHost().bindInteractiveConfirmTransport("session-1", interactive);
    getAgentHost().bindHeadlessConfirmTransport("run-1", headless);
    getAgentHost().unbindConfirmTransport("session-1");

    expect(mocks.createInteractiveConfirmTransport).toHaveBeenCalledWith({ sessionId: "session-1", ...interactive });
    expect(mocks.createHeadlessConfirmTransport).toHaveBeenCalledWith(headless);
    expect(mocks.setConfirmTransport).toHaveBeenCalledWith("session-1", transport);
    expect(mocks.setConfirmTransport).toHaveBeenCalledWith("run-1", transport);
    expect(mocks.setConfirmTransport).toHaveBeenCalledWith("session-1", undefined);
  });

  it("delegates chat-agent drops and job kills through the host", async () => {
    mocks.dropChatAgentForThread.mockResolvedValue(undefined);
    mocks.killJob.mockReturnValue({ ok: true });

    await getAgentHost().dropChatAgentForThread("thread-1");
    expect(getAgentHost().killJob("job-1", "session-1")).toEqual({ ok: true });

    expect(mocks.dropChatAgentForThread).toHaveBeenCalledWith("thread-1");
    expect(mocks.killJob).toHaveBeenCalledWith("job-1", "session-1");
  });

  it("routes automation turns through the host", async () => {
    const options = { sessionId: "automation-1" } as never;
    const result = { ok: true };
    mocks.runCordisCodingLoop.mockResolvedValue(result);

    await expect(getAgentHost().runAutomation(options)).resolves.toBe(result);

    expect(mocks.runCordisCodingLoop).toHaveBeenCalledWith(options);
  });

  it("shuts down the Cordis runtime once", async () => {
    getAgentHost().startTurn("session-shutdown");
    mocks.shutdownContext.mockResolvedValue(undefined);

    await getAgentHost().shutdown();
    await getAgentHost().shutdown();

    expect(getAgentHost().isTurnRunning("session-shutdown")).toBe(false);
    expect(mocks.clearAllPendingQuestions).toHaveBeenCalledOnce();
    expect(mocks.clearAllSessionGrants).toHaveBeenCalledOnce();
    expect(mocks.clearAllSecretGrants).toHaveBeenCalledOnce();
    expect(mocks.shutdownContext).toHaveBeenCalledOnce();
  });

  it("releases a resident session agent best-effort", async () => {
    const contextWithAgents = { ...context, agents: { delete: mocks.deleteAgent } };
    mocks.getContext.mockResolvedValue(contextWithAgents);

    await getAgentHost().releaseSessionAgent("session-1");

    expect(mocks.deleteAgent).toHaveBeenCalledWith("session-1");
  });
});
