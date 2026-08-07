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
import { runAgentLoop, type PiAgentSession, type AgentLLMConfig, type AgentToolContext } from "../pi-agent-loop";
import { createDeltaBatcher } from "../delta-batcher";

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
  parentToolCtx: AgentToolContext,
  parentLlmConfig: AgentLLMConfig,
): Promise<string> {
  const childSessionId = `${parentToolCtx.sessionId}:sub:${randomBytes(4).toString("hex")}`;

  const childToolCtx: AgentToolContext = {
    ...parentToolCtx,
    cwd:       args.cwd ?? parentToolCtx.cwd,
    sessionId: childSessionId,
    req:       { ...parentToolCtx.req, threadId: childSessionId },
  };

  const llmConfig: AgentLLMConfig = {
    ...parentLlmConfig,
    model: args.model ?? parentLlmConfig.model,
  };

  // Tell the renderer a subagent is starting
  parentToolCtx.send("pi-agent:subagent", {
    parentSessionId: parentToolCtx.sessionId,
    childSessionId,
    status: "start",
  });

  const session: PiAgentSession = {
    messages: [{ role: "user", content: args.prompt }],
    abortCtrl: new AbortController(),
  };

  const date = new Date().toLocaleDateString("en-US", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
  });

  const systemPrompt =
    `You are a focused sub-agent. Complete the given task thoroughly, use tools as needed, ` +
    `then respond with a clear, concise final answer. Do not ask clarifying questions.\n\n` +
    `## Context\n- **Date:** ${date}`;

  let errorMessage = "";

  // Coalesce the child's streamed deltas like the parent loop (one IPC event
  // per flush instead of per token). Flushed after the loop below.
  const tokens = createDeltaBatcher((delta) => childToolCtx.send("pi-agent:token", { sessionId: childSessionId, delta }));
  const thoughts = createDeltaBatcher((delta) => childToolCtx.send("pi-agent:thought", { sessionId: childSessionId, delta }));

  await runAgentLoop(
    session,
    systemPrompt,
    llmConfig,
    {
      onToken:       (delta) => tokens.push(delta),
      onThought:     (delta) => thoughts.push(delta),
      onToolsReady:  ()     => childToolCtx.send("pi-agent:tools-ready", { sessionId: childSessionId }),
      onToolPending: (name, callId) => childToolCtx.send("pi-agent:tool", { sessionId: childSessionId, name, label: name, callId, status: "pending" }),
      onToolStart:   (name, label, callId) => childToolCtx.send("pi-agent:tool", { sessionId: childSessionId, name, label, callId, status: "start" }),
      onToolEnd:     (name, label, ok, output, callId) => childToolCtx.send("pi-agent:tool", { sessionId: childSessionId, name, label, callId, status: "end", ok, output }),
      onStepStart:  () => childToolCtx.send("pi-agent:step", { sessionId: childSessionId }),
      // Usage recording for the child happens inside runAgentLoop with source
      // "pi-subagent"; this callback only relays the renderer event. Args are in
      // AgentLoopCallbacks.onUsage order — every value forwarded under its own
      // field (a mis-shift here would silently mislabel the subagent's ring).
      onUsage:      (promptTokens, completionTokens, reasoningTokens, breakdown, costUsd, cacheReadTokens, cacheCreationTokens) => childToolCtx.send("pi-agent:usage", {
        sessionId: childSessionId,
        promptTokens,
        completionTokens,
        reasoningTokens,
        breakdown,
        costUsd,
        cacheReadTokens,
        cacheCreationTokens,
      }),
      onDone:       () => { /* handled below via session.messages */ },
      onError:      (msg) => { errorMessage = msg; },
    },
    childToolCtx,
    "execute",
    "pi-subagent",
  );

  // Flush any remaining buffered deltas (covers done, error, max-steps, abort).
  tokens.flush();
  thoughts.flush();

  // Extract the final assistant message from history
  const lastAssistant = [...session.messages]
    .reverse()
    .find((m) => m.role === "assistant");

  const finalAnswer =
    lastAssistant && "content" in lastAssistant && lastAssistant.content
      ? lastAssistant.content
      : "";

  const result = errorMessage
    ? `Sub-agent error: ${errorMessage}`
    : finalAnswer || "(sub-agent produced no output)";

  // Notify renderer the subagent is done
  parentToolCtx.send("pi-agent:subagent", {
    parentSessionId: parentToolCtx.sessionId,
    childSessionId,
    status: "done",
    result,
  });

  return result;
}
