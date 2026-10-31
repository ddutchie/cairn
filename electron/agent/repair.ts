/**
 * After a crash, assistant tool calls may have no result. Providers reject such
 * histories, so synthesize an "interrupted" result for each. Pure; the loop
 * and the session reader both use it.
 */
import type { Message, ToolResultMessage } from "@earendil-works/pi-ai";

export function repairInterrupted(messages: readonly Message[], now: number = Date.now()): Message[] {
  const out: Message[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    out.push(msg);
    if (msg.role !== "assistant") continue;
    const answered = new Set<string>();
    for (let j = i + 1; j < messages.length && messages[j].role === "toolResult"; j++) {
      answered.add((messages[j] as ToolResultMessage).toolCallId);
    }
    for (const block of msg.content) {
      if (block.type !== "toolCall" || answered.has(block.id)) continue;
      out.push({
        role: "toolResult",
        toolCallId: block.id,
        toolName: block.name,
        content: [{ type: "text", text: "Interrupted before this tool finished; its effects are unknown." }],
        isError: true,
        timestamp: now,
      });
    }
  }
  return out;
}
