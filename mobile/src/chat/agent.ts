/**
 * Streaming agent loop for mobile chat — provider-agnostic native tool-calling.
 *
 * Per turn we stream the model's response (via the active provider — Rork or
 * OpenAI-compatible, see providers/), surfacing text deltas live and collecting
 * any tool calls it emits. When the turn finishes with tool calls we execute
 * them locally (expo-sqlite), merge the results back into the assistant message
 * (state:"output-available"), and run the next turn. Loop until the model
 * finishes with plain text (no tool calls).
 */

import { resolveProvider } from "./providers";
import {
  msgId,
  type UIMessage,
  type UIPart,
  type ToolPart,
  type FilePart,
} from "./providers/types";
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
  const now = new Date();
  // Human-readable date (with weekday) for relative reasoning, plus the ISO
  // date so the model emits correct YYYY-MM-DD values for tool args (dueDate).
  const humanDate = now.toLocaleDateString(undefined, {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  const isoDate = now.toISOString().slice(0, 10);
  return {
    id: msgId(),
    role: "system",
    parts: [
      {
        type: "text",
        text: [
          "You are Cairn's mobile assistant. You help the user read and edit their notes and tasks.",
          `The current date is ${humanDate} (${isoDate}). Use it to resolve relative dates like "tomorrow" or "next week", and always pass dates to tools as YYYY-MM-DD.`,
          "You have tools that run against the user's local workspace; writes sync to their desktop.",
          "ALWAYS begin by calling get_cairn_context to get project ids, columns, and tags — there is no separate 'list projects' tool.",
          "To summarise or reason about a project, then call get_project_context_pack(project_id): it returns the project, columns, pinned notes, open tasks grouped by column, and recent activity in one call. Prefer it over many small list/get calls.",
          "Look up ids with read tools before writing — never invent an id.",
          "When you mention a specific note in your reply, wrap its exact title in [[double brackets]] so the user can tap it to open the note.",
          "After a successful write, briefly confirm what you did. Answer in concise markdown.",
        ].join(" "),
      },
    ],
  };
}

/** An image/file attachment for a user message (data URI). */
export interface Attachment {
  mediaType: string;
  url: string;
  name?: string;
}

/**
 * Build a user message. Attachments (images) become native "file" parts so the
 * model receives them as multimodal input via /agent/chat. Text always leads so
 * a caption reads before its image.
 */
export function userMessage(text: string, attachments?: Attachment[]): UIMessage {
  const parts: UIPart[] = [];
  if (text) parts.push({ type: "text", text });
  for (const a of attachments ?? []) {
    parts.push({ type: "file", mediaType: a.mediaType, url: a.url, name: a.name } as FilePart);
  }
  // A message with only an image still needs a part; guarantee non-empty.
  if (parts.length === 0) parts.push({ type: "text", text: "" });
  return { id: msgId(), role: "user", parts };
}

/**
 * Build an assistant message from stored text — used to rehydrate the agent
 * conversation from persisted history so context survives an app relaunch.
 * (Tool parts aren't restored; the prior text is enough for continuity.)
 */
export function assistantMessage(text: string): UIMessage {
  return { id: msgId(), role: "assistant", parts: [{ type: "text", text }] };
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

  // Ensure the conversation is led by an up-to-date system prompt. Refresh it
  // each run so the injected current date doesn't go stale in a long session.
  if (conversation[0]?.role === "system") {
    conversation[0] = systemMessage();
  } else {
    conversation.unshift(systemMessage());
  }

  let provider;
  try {
    provider = await resolveProvider();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    onEvent?.({ type: "error", text: msg });
    return msg;
  }

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    // Build the assistant message we're producing this turn.
    const assistant: UIMessage = { id: msgId(), role: "assistant", parts: [] };
    let text = "";
    const toolCalls: { id: string; name: string; input: unknown }[] = [];
    let finishReason: string | undefined;

    try {
      for await (const ev of provider.stream(conversation, tools, signal)) {
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

/**
 * Single-shot text completion for the note editor's AI actions (rephrase,
 * summarise, expand, …). No tools, no history — just send the built prompt and
 * return the model's plain-text reply (streaming deltas via onDelta). Online
 * only, like chat.
 */
export async function runTextAction(
  prompt: string,
  onDelta?: (delta: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  const conversation: UIMessage[] = [userMessage(prompt)];
  let text = "";
  const provider = await resolveProvider();
  for await (const ev of provider.stream(conversation, {}, signal)) {
    if (ev.type === "text-delta" && typeof (ev as { delta?: string }).delta === "string") {
      const delta = (ev as { delta: string }).delta;
      text += delta;
      onDelta?.(delta);
    }
  }
  return text.trim();
}
