/**
 * Regression tests for electron/lib/coding-tools/subagent.ts — specifically the
 * onUsage relay to the renderer.
 *
 * The subagent's `pi-agent:usage` event must forward every usage argument in
 * AgentLoopCallbacks.onUsage order under its own field. A mis-shift here
 * silently mislabels the subagent's context ring (reasoning tokens shown as
 * breakdown, cache tokens dropped, etc.). We drive runAgentLoop's onUsage
 * callback directly with distinct values and assert the exact payload.
 */

import { it, expect, vi, beforeEach } from "vitest";
import { spawnSubagentTool, type SpawnSubagentArgs } from "./subagent";
import { runAgentLoop, type AgentLLMConfig, type AgentToolContext, type AgentLoopCallbacks } from "../pi-agent-loop";

vi.mock("../pi-agent-loop", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../pi-agent-loop")>();
  return { ...mod, runAgentLoop: vi.fn() };
});

const runAgentLoopMock = vi.mocked(runAgentLoop);

const LLM_CONFIG: AgentLLMConfig = {
  baseUrl: "https://api.example.com",
  model: "test-model",
  apiKey: "key",
  maxSteps: 5,
  temperature: 0.3,
};

function makeToolCtx(send: (channel: string, payload: unknown) => void): AgentToolContext {
  return {
    cwd: "/tmp",
    db: {} as AgentToolContext["db"],
    req: { threadId: "parent", message: "x", config: {} } as AgentToolContext["req"],
    workspacePath: "/tmp/ws",
    sessionId: "parent",
    send,
  };
}

let callbacks: AgentLoopCallbacks;
beforeEach(() => {
  callbacks = undefined as unknown as AgentLoopCallbacks;
  runAgentLoopMock.mockImplementation(async (
    _session,
    _systemPrompt,
    _config,
    cb: AgentLoopCallbacks,
  ) => {
    callbacks = cb;
  });
});

it("forwards every onUsage argument under its own field (no shifting)", async () => {
  const send = vi.fn();
  const ctx = makeToolCtx(send);
  const run = spawnSubagentTool({ prompt: "do a thing" } as SpawnSubagentArgs, ctx, LLM_CONFIG);
  // runAgentLoop is mocked; let the async function reach the callback capture.
  await new Promise((r) => setImmediate(r));
  expect(callbacks).toBeDefined();

  const breakdown = { systemPrompt: 10, skills: 0, tools: 1, conversation: 2, toolOutputs: 3, rules: 0, mcp: 0, subagentDefinitions: 4 };
  callbacks.onUsage(111, 222, 333, breakdown, 0.44, 555, 666);
  await run;

  const usage = send.mock.calls.find(([ch]) => ch === "pi-agent:usage");
  expect(usage).toBeDefined();
  const [channel, payload] = usage as [string, Record<string, unknown>];

  expect(channel).toBe("pi-agent:usage");
  expect(String(payload.sessionId)).toMatch(/^parent:sub:/);
  expect(payload).toMatchObject({
    promptTokens: 111,
    completionTokens: 222,
    reasoningTokens: 333,
    breakdown,
    costUsd: 0.44,
    cacheReadTokens: 555,
    cacheCreationTokens: 666,
  });
  expect(String(payload.sessionId)).toBe(String(send.mock.calls.find(([ch]) => ch === "pi-agent:subagent")?.[1]?.childSessionId));
});
