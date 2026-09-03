import type { ConversationMessage, ConversationLiveToolCall } from "./conversation-message";

/**
 * The in-flight turn, rendered as a normal message.
 *
 * Chat historically drew its live turn OUTSIDE the message list (a Virtuoso
 * footer containing `ToolCallIndicator`, a second tool-chip renderer) while
 * Coding pushed a real streaming message INTO the list. Two renderers of one
 * event stream is what let the empty-bubble bug reach only Coding, and what left
 * chat with no approval card, no expandable output, and no Open file / View
 * diff — `ToolCallIndicator` simply never grew those branches.
 *
 * Lifting the pop-out's synthesis (which was already profile-agnostic) into one
 * shared helper means every surface appends the live turn to `messages` and gets
 * the full `ConversationMessageBubble` treatment.
 */

/** The subset of the `useSessionConversation` result this needs. */
export interface LiveTurnState {
  isLoading: boolean;
  streamingContent: string;
  streamingThought: string;
  toolCalls: readonly ConversationLiveToolCall[];
  subagents: readonly unknown[];
}

/**
 * Tool arguments arrive as a JSON string off the wire. The pop-out parsed them
 * with a bare `JSON.parse`, which throws on a truncated payload — and a throw
 * here would take down the whole transcript mid-stream, since args are re-parsed
 * on every token. Degrade to `undefined` instead.
 */
function parseArgs(raw: string | undefined): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Build the live assistant message, or `null` when the turn has nothing to show.
 *
 * `createdAt` is a parameter rather than `new Date()` so callers can hold one
 * stable value per turn — generating it inline produces a different timestamp on
 * every token.
 */
export function toLiveConversationMessage(
  sessionId: string,
  state: LiveTurnState,
  createdAt: string,
): ConversationMessage | null {
  const { isLoading, streamingContent, streamingThought, toolCalls, subagents } = state;
  const hasAnything = isLoading
    || streamingContent.length > 0
    || streamingThought.length > 0
    || toolCalls.length > 0
    || subagents.length > 0;
  if (!hasAnything) return null;

  return {
    id: `stream-${sessionId}`,
    role: "assistant",
    content: streamingContent,
    reasoning: streamingThought || undefined,
    toolCalls: toolCalls.map((tool) => ({
      callId: tool.callId,
      name: tool.tool,
      label: tool.label,
      viewTitle: tool.viewTitle,
      resultView: tool.resultView,
      args: parseArgs(tool.args),
      running: tool.status === "running",
      ok: tool.ok !== false,
      output: tool.output,
      error: tool.error,
      meta: tool.meta,
      confirmRequired: tool.confirmRequired,
      approvalNonce: tool.approvalNonce,
      cairnRef: tool.cairnRef,
      externalRef: tool.externalRef,
    })),
    subagents: subagents as unknown[],
    isStreaming: true,
    createdAt,
  };
}

/** Append the live turn to the settled transcript, when there is one. */
export function withLiveTurn(
  messages: readonly ConversationMessage[],
  live: ConversationMessage | null,
): ConversationMessage[] {
  return live ? [...messages, live] : [...messages];
}
