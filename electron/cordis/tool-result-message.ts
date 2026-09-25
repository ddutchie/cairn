/**
 * Read one tool result out of a dsh message.
 *
 * Session format v4 (dsh 0.1.7) stores each result as a first-class
 * `role: "tool"` message: `toolCallId` / `isError` live on the message and
 * `content` holds the output blocks directly. Formats ≤ v3 wrapped the output
 * in a `{ type: "tool-result", toolCallId, isError, content }` block inside a
 * user-role message. dsh migrates v3 logs when it opens them, so live events
 * and replay are v4; the wrapper branch only keeps hand-built fixtures and any
 * unmigrated projection readable.
 */

export interface ToolResultRead {
  callId?: string;
  output: string;
  isError: boolean;
}

interface Block {
  type?: string;
  text?: string;
  toolCallId?: string;
  isError?: boolean;
  content?: readonly Block[];
}

interface MessageLike {
  role?: string;
  toolCallId?: string;
  isError?: boolean;
  source?: { callId?: string } | unknown;
  content?: readonly Block[];
}

function textOf(blocks: readonly Block[] | undefined): string {
  return (blocks ?? []).filter((b) => b.type === "text" && b.text).map((b) => b.text).join("");
}

/** True when the message carries tool results in either format. */
export function isToolResultMessage(message: unknown): boolean {
  const m = message as MessageLike | undefined;
  if (!m) return false;
  return m.role === "tool" || (m.content ?? []).some((b) => b.type === "tool-result");
}

/** Every tool result the message carries (one for v4, one or more for v3 wrappers). */
export function readToolResults(message: unknown): ToolResultRead[] {
  const m = message as MessageLike | undefined;
  if (!m) return [];
  const wrapped = (m.content ?? []).filter((b) => b.type === "tool-result");
  const sourceCallId = (m.source as { callId?: string } | undefined)?.callId;
  if (wrapped.length > 0) {
    return wrapped.map((b) => ({ callId: b.toolCallId ?? sourceCallId, output: textOf(b.content), isError: b.isError === true }));
  }
  if (m.role !== "tool") return [];
  return [{ callId: m.toolCallId ?? sourceCallId, output: textOf(m.content), isError: m.isError === true }];
}

/** The single result on a `tool/result` event message (first one for v3 wrappers). */
export function readToolResult(message: unknown): ToolResultRead | undefined {
  return readToolResults(message)[0];
}
