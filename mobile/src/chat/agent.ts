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
  type ChatUsage,
} from "./providers/types";
import { toolsForAgent, allToolMap } from "./tools";
import { computeBreakdown, scaleBreakdown } from "./token-breakdown";
import { MAX_PERSONALITY_PROMPT_CHARS } from "@cairn/shared/chat/registry-schema";
import { getChatPersonalityId } from "./ai-config";
import { getCachedPersonalitiesManifest } from "./personalities-registry";

// Max model round-trips per user turn. Each turn is one model call; a turn that
// requests tools runs them all, then loops for the model's follow-up (which sees
// the outputs). Introspective research chains many single-tool reads (get note →
// search → get note range → …), so this must be generous — matched to the
// desktop default (DEFAULT_AGENT_CONFIG.maxSteps in src/lib/constants.ts).
const MAX_TURNS = 30;

export interface AgentEvent {
  type: "text-delta" | "reasoning-delta" | "tool-start" | "tool" | "final" | "error";
  delta?: string; // for text-delta / reasoning-delta
  tool?: string;
  toolCallId?: string; // correlates a "tool-start" with its later "tool"
  args?: unknown;
  result?: unknown;
  text?: string; // full text for final / error
  reasoning?: string; // accumulated reasoning text, on "final"
  usage?: ChatUsage; // context-window usage, on "final"
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
        // Lean: the tool descriptions (sent in the tools array) carry per-tool
        // guidance, so this holds only cross-cutting rules. A live experiment
        // (desktop note "AI Agent Identity & System Prompts") confirmed a ~95-tok
        // prompt matches the previous ~224-tok one for tool selection.
        text: [
          "You are Cairn's mobile assistant for the user's notes and tasks; writes sync to their desktop.",
          `The current date is ${humanDate} (${isoDate}). Resolve relative dates like "tomorrow"/"next week" against it, and pass dates to tools as YYYY-MM-DD.`,
          "Call get_cairn_context first to get project ids, columns, and tags (there is no separate 'list projects' tool), then reuse them — never invent an id. Choose the tool whose description matches the request.",
          "For information beyond the user's notes/tasks — current events, external facts, docs — use any connected web/search tools available to you, and cite sources as markdown links.",
          "When you mention a specific note or task, link it as [[id]] using its exact id (it renders as the title and can't be confused with a same-titled item); if you don't have the id, [[Title]] also works. After a write, briefly confirm. Answer in concise markdown.",
          "Writing in the user's voice: when the user asks you to draft or rewrite content that sounds like them (emails, replies, notes), call get_user_writing_style first and match it. If it reports configured:false, write in a natural, clear voice instead.",
          ...personalityLayer(),
        ].join(" "),
      },
    ],
  };
}

/**
 * The selected chat personality as an appended style LAYER, or [] when none is
 * picked / the registry isn't cached. Mirrors the desktop withPersonality: the
 * rules are added under their own header as session style guidance, truncated to
 * the shared MAX_PERSONALITY_PROMPT_CHARS ceiling so a bad registry entry can't
 * bloat the system prompt.
 */
function personalityLayer(): string[] {
  const id = getChatPersonalityId();
  if (!id) return [];
  const entry = getCachedPersonalitiesManifest()?.personalities.find((p) => p.id === id);
  if (!entry) return [];
  const prompt =
    entry.definition.prompt.length > MAX_PERSONALITY_PROMPT_CHARS
      ? entry.definition.prompt.slice(0, MAX_PERSONALITY_PROMPT_CHARS)
      : entry.definition.prompt;
  const blurb = entry.definition.description ? ` (${entry.definition.description})` : "";
  return [`Personality: ${entry.definition.name}${blurb}\n${prompt}`];
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
  // Resolve the executable map ONCE for this run so the tools we advertise and
  // the tools we can execute stay in lock-step even if a toggle/install changes
  // mid-run. Includes built-ins + enabled installed services.
  const toolMap = allToolMap();
  let finalText = "";
  // Accumulated reasoning ("thinking") text across the run's turns (PCC only).
  let reasoning = "";
  // Context-window usage from the latest turn's finish event (Apple provider).
  let usage: ChatUsage | undefined;

  // Attach an on-device prompt-token breakdown to the provider's usage so the
  // context ring can show the per-category split (system / tools / MCP /
  // conversation / tool outputs) like desktop. Computed from the exact messages
  // the model saw this run, then rescaled to the provider's authoritative
  // promptTokens so the segments sum to the number the ring displays.
  const withBreakdown = (u: ChatUsage | undefined): ChatUsage | undefined => {
    if (!u) return u;
    if (u.breakdown) return u; // provider already supplied one
    try {
      const estimate = computeBreakdown(conversation, tools);
      const breakdown =
        u.promptTokens > 0 ? scaleBreakdown(estimate, u.promptTokens) : estimate;
      return { ...u, breakdown };
    } catch {
      return u; // never let breakdown counting break a turn
    }
  };

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
        } else if (ev.type === "reasoning-delta" && typeof (ev as { delta?: string }).delta === "string") {
          const delta = (ev as { delta: string }).delta;
          reasoning += delta;
          onEvent?.({ type: "reasoning-delta", delta });
        } else if (ev.type === "tool-input-available") {
          const e = ev as { toolCallId: string; toolName: string; input: unknown };
          toolCalls.push({ id: e.toolCallId, name: e.toolName, input: e.input });
        } else if (ev.type === "tool-executed") {
          // Provider already ran this tool (e.g. Apple's native tool-calling).
          // Record it in history for continuity and surface it for display, but
          // do NOT queue it for re-execution.
          const e = ev as { toolCallId: string; toolName: string; input: unknown; output: unknown };
          assistant.parts.push({
            type: `tool-${e.toolName}`,
            toolCallId: e.toolCallId,
            toolName: e.toolName,
            state: "output-available",
            input: e.input,
            output: { type: "text", value: JSON.stringify(e.output ?? {}) },
          } as UIPart);
       onEvent?.({ type: "tool", tool: e.toolName, args: e.input, result: e.output });
        } else if (ev.type === "finish") {
          finishReason = (ev as { finishReason?: string }).finishReason;
          const u = (ev as { usage?: ChatUsage }).usage;
          if (u) usage = u;
        }
      }
    } catch (e) {
      // AppleLLMError already carries a user-friendly message (quota, PCC network,
      // unavailable, etc.) — pass it through verbatim rather than prefixing
      // "Error:". Otherwise map generic network failures to a connection hint.
      const isAppleErr = e instanceof Error && e.name === "AppleLLMError";
      const msg = isAppleErr
        ? (e as Error).message
        : e instanceof Error && /network|fetch|abort|failed|\(5\d\d\)/i.test(e.message)
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
      onEvent?.({ type: "final", text: finalText, reasoning: reasoning || undefined, usage: withBreakdown(usage) });
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

      // Announce the call BEFORE running it, so the UI can show a "running" chip
      // for slow tools (MCP/web search can take seconds) instead of nothing until
      // the result lands.
      onEvent?.({ type: "tool-start", tool: call.name, toolCallId: call.id, args: call.input });

      const tool = toolMap.get(call.name);
      let result: unknown;
      if (!tool) {
        result = { error: `Unknown tool: ${call.name}` };
      } else {
        try {
          result = await tool.run((call.input as Record<string, unknown>) ?? {});
        } catch (err) {
          result = { error: err instanceof Error ? err.message : String(err) };
        }
      }
       onEvent?.({ type: "tool", tool: call.name, toolCallId: call.id, args: call.input, result });

      toolPart.state = "output-available";
      toolPart.output = { type: "text", value: JSON.stringify(result) };
    }

    conversation.push(assistant);
    // Loop for the model's follow-up turn (it now sees the tool outputs).
    if (finishReason === "stop") {
      onEvent?.({ type: "final", text: finalText, reasoning: reasoning || undefined, usage: withBreakdown(usage) });
      return finalText;
    }
  }

  // Reaching here means every turn requested tools and we ran out of turns. The
  // limit MUST be reported even if an earlier turn produced partial text — a
  // bare `finalText || …` would silently swallow the notice and pass the
  // half-finished answer off as complete.
  const limitNote = `I reached the maximum of ${MAX_TURNS} steps. Any changes made have been saved — try a more focused request.`;
  const msg = finalText ? `${finalText}\n\n${limitNote}` : limitNote;
  onEvent?.({ type: "final", text: msg, reasoning: reasoning || undefined, usage: withBreakdown(usage) });
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
