/**
 * spawn_subagent — coding tool
 *
 * Runs a nested PiAgentLoop with a fresh message history and returns only the
 * final assistant message to the parent agent. This keeps the parent context
 * lean while allowing deep multi-step sub-tasks.
 *
 * The subagent streams its own pi-agent:* events on a child session ID
 * (`${parentSessionId}:sub:<uuid>`) so the renderer can render it inline.
 */

import { randomBytes } from "crypto";
import type Database from "better-sqlite3";
import type { BrowserWindow } from "electron";
import { runAgentLoop, type PiAgentSession, type AgentLLMConfig } from "../pi-agent-loop";
import type { ChatRequest } from "../tools";

export interface SpawnSubagentArgs {
  prompt: string;
  /** Override cwd for the subagent — defaults to parent cwd */
  cwd?: string;
  /** Override model for the subagent — defaults to parent model */
  model?: string;
}

export const spawnSubagentDefinition = {
  type: "function" as const,
  function: {
    name: "spawn_subagent",
    description:
      "Spawn a focused sub-agent to handle a contained research or coding task without polluting the parent context. " +
      "The sub-agent runs a full tool-calling loop and returns only its final answer. " +
      "Use this for deep file searches, multi-file refactors, or any task that would generate many tool calls. " +
      "The user can expand the subagent trace inline to inspect its reasoning.",
    parameters: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "The task for the sub-agent to complete. Be specific and self-contained.",
        },
        cwd: {
          type: "string",
          description: "Working directory override. Defaults to the parent agent's cwd.",
        },
        model: {
          type: "string",
          description: "LLM model override for the sub-agent (e.g. gpt-4o-mini for lighter tasks).",
        },
      },
      required: ["prompt"],
    },
  },
};

export async function spawnSubagentTool(
  args: SpawnSubagentArgs,
  parentCwd: string,
  parentLlmConfig: AgentLLMConfig,
  db: Database.Database,
  parentReq: ChatRequest,
  workspacePath: string,
  parentSessionId: string,
  send: (channel: string, payload: unknown) => void,
  getWin?: () => BrowserWindow | null,
): Promise<string> {
  const childSessionId = `${parentSessionId}:sub:${randomBytes(4).toString("hex")}`;
  const cwd = args.cwd ?? parentCwd;
  const llmConfig: AgentLLMConfig = {
    ...parentLlmConfig,
    model: args.model ?? parentLlmConfig.model,
  };

  // Tell the renderer a subagent is starting
  send("pi-agent:subagent", {
    parentSessionId,
    childSessionId,
    status: "start",
  });

  const session: PiAgentSession = {
    messages: [{ role: "user", content: args.prompt }],
    abortCtrl: new AbortController(),
  };

  const systemPrompt =
    "You are a focused sub-agent. Complete the given task thoroughly, use tools as needed, " +
    "then respond with a clear, concise final answer. Do not ask clarifying questions.";

  let finalAnswer = "";
  let errorMessage = "";

  await runAgentLoop(
    session,
    systemPrompt,
    cwd,
    llmConfig,
    db,
    { ...parentReq, threadId: childSessionId },
    workspacePath,
    {
      onToken:       (delta) => send("pi-agent:token",      { sessionId: childSessionId, delta }),
      onToolsReady:  ()     => send("pi-agent:tools-ready", { sessionId: childSessionId }),
      onToolPending: (name, callId) => send("pi-agent:tool", { sessionId: childSessionId, name, label: name, callId, status: "pending" }),
      onToolStart:   (name, label, callId) => send("pi-agent:tool", { sessionId: childSessionId, name, label, callId, status: "start" }),
      onToolEnd:     (name, label, ok, output, callId) => send("pi-agent:tool", { sessionId: childSessionId, name, label, callId, status: "end", ok, output }),
      onStepStart:  () => send("pi-agent:step", { sessionId: childSessionId }),
      onUsage:      (pt, ct) => send("pi-agent:usage", { sessionId: childSessionId, promptTokens: pt, completionTokens: ct }),
      onDone:       () => { /* handled below */ },
      onError:      (msg) => { errorMessage = msg; },
    },
    getWin,
  );

  // Extract the final assistant message from history
  const lastAssistant = [...session.messages]
    .reverse()
    .find((m) => m.role === "assistant");
  if (lastAssistant && "content" in lastAssistant && lastAssistant.content) {
    finalAnswer = lastAssistant.content;
  }

  const result = errorMessage
    ? `Sub-agent error: ${errorMessage}`
    : finalAnswer || "(sub-agent produced no output)";

  // Notify renderer the subagent is done
  send("pi-agent:subagent", {
    parentSessionId,
    childSessionId,
    status: "done",
    result,
  });

  return result;
}
