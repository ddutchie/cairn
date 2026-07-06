/**
 * Streaming agent loop for mobile chat — native tool-calling via /agent/chat.
 *
 * Per turn we stream the model's response, surfacing text deltas live and
 * collecting any tool calls it emits. When the turn finishes with tool calls we
 * execute them locally (expo-sqlite), merge the results back into the assistant
 * message (state:"output-available", per the Rork/AI-SDK contract), and run the
 * next turn. Loop until the model finishes with plain text (no tool calls).
 */

import {
  streamAgentChat,
  msgId,
  type UIMessage,
  type UIPart,
  type ToolPart,
} from "./rork-client";
import { toolsForAgent, TOOL_MAP } from "./tools";

const MAX_TURNS = 8;

export interface AgentEvent {
  type: "text-delta" | "tool" | "final" | "error";
  delta?: string; // for text-delta
  tool?: string;
  args?: unknown;
  result?: unknown;
  text?: string; // full text for final / error
}

/** Build the system message (as a UIMessage part). */
function systemMessage(): UIMessage {
  return {
    id: msgId(),
    role: "system",
    parts: [
      {
        type: "text",
        text: [
          "You are Cairn's mobile assistant. You help the user read and edit their notes and tasks.",
          "You have tools that run against the user's local workspace; writes sync to their desktop.",
          "Start by calling get_cairn_context for ids/structure. To summarise or reason about a project, call get_project_context_pack(project_id) — it returns the project, columns, pinned notes, open tasks grouped by column, and recent activity in one call (prefer it over many list/get calls).",
          "Look up ids with read tools before writing — never invent an id.",
          "After a successful write, briefly confirm what you did. Answer in concise markdown.",
        ].join(" "),
      },
    ],
  };
}

export function userMessage(text: string): UIMessage {
  return { id: msgId(), role: "user", parts: [{ type: "text", text }] };
}

/**
 * Run the agent to completion. `conversation` is the running UIMessage history
 * (system + prior user/assistant turns). Mutated in place with new turns.
 * Streams events via onEvent; returns the final assistant text.
 */
export async function runAgent(
  conversation: UIMessage[],
  onEvent?: (e: AgentEvent) => void,
  signal?: AbortSignal,
): Promise<string> {
  const tools = toolsForAgent();
  let finalText = "";

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    // Build the assistant message we're producing this turn.
    const assistant: UIMessage = { id: msgId(), role: "assistant", parts: [] };
    let text = "";
    const toolCalls: { id: string; name: string; input: unknown }[] = [];
    let finishReason: string | undefined;

    try {
      for await (const ev of streamAgentChat(conversation, tools, signal)) {
        if (ev.type === "text-delta" && typeof (ev as { delta?: string }).delta === "string") {
          const delta = (ev as { delta: string }).delta;
          text += delta;
          onEvent?.({ type: "text-delta", delta });
        } else if (ev.type === "tool-input-available") {
          const e = ev as { toolCallId: string; toolName: string; input: unknown };
          toolCalls.push({ id: e.toolCallId, name: e.toolName, input: e.input });
        } else if (ev.type === "finish") {
          finishReason = (ev as { finishReason?: string }).finishReason;
        }
      }
    } catch (e) {
      const msg =
        e instanceof Error && /network|fetch|abort|failed|\(5\d\d\)/i.test(e.message)
          ? "Chat needs a connection. Reconnect and try again."
          : `Error: ${e instanceof Error ? e.message : String(e)}`;
      onEvent?.({ type: "error", text: msg });
      return msg;
    }

    // Record the assistant text part.
    if (text) assistant.parts.push({ type: "text", text });
    finalText = text || finalText;

    // No tool calls → we're done.
    if (toolCalls.length === 0) {
      // Ensure the assistant turn is in history even if empty-ish.
      if (assistant.parts.length === 0) assistant.parts.push({ type: "text", text: finalText });
      conversation.push(assistant);
      onEvent?.({ type: "final", text: finalText });
      return finalText;
    }

    // Execute each tool locally, appending an input-available part then filling
    // in its output (state:"output-available") — the shape /agent/chat expects.
    for (const call of toolCalls) {
      const toolPart: ToolPart = {
        type: `tool-${call.name}`,
        toolCallId: call.id,
        toolName: call.name,
        state: "input-available",
        input: call.input,
      };
      assistant.parts.push(toolPart as UIPart);

      const tool = TOOL_MAP.get(call.name);
      let result: unknown;
      if (!tool) {
        result = { error: `Unknown tool: ${call.name}` };
      } else {
        try {
          result = tool.run((call.input as Record<string, unknown>) ?? {});
        } catch (err) {
          result = { error: err instanceof Error ? err.message : String(err) };
        }
      }
      onEvent?.({ type: "tool", tool: call.name, args: call.input, result });

      toolPart.state = "output-available";
      toolPart.output = { type: "text", value: JSON.stringify(result) };
    }

    conversation.push(assistant);
    // Loop for the model's follow-up turn (it now sees the tool outputs).
    if (finishReason === "stop") {
      onEvent?.({ type: "final", text: finalText });
      return finalText;
    }
  }

  const msg = finalText || "I couldn't finish that in a reasonable number of steps.";
  onEvent?.({ type: "final", text: msg });
  return msg;
}
