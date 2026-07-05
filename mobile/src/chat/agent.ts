/**
 * Prompt-based tool loop for mobile chat (ReAct style).
 *
 * Rork has no native function-calling, but reliably returns structured JSON
 * when instructed. So we describe the tools + a strict JSON protocol in the
 * system prompt, call Rork, parse its completion as either a tool call or a
 * final answer, execute tool calls locally against the expo-sqlite DB, feed the
 * result back, and repeat until a final answer or the iteration cap.
 */

import { rorkComplete, type ChatMsg } from "./rork-client";
import { TOOLS, TOOL_MAP } from "./tools";

const MAX_STEPS = 6;

function systemPrompt(): string {
  const toolList = TOOLS.map((t) => `- ${t.name}: ${t.description} args ${t.params}`).join("\n");
  return [
    "You are Cairn's mobile assistant. You help the user read and edit their notes and tasks.",
    "You can call tools that run against the user's local workspace. Writes sync to their desktop.",
    "",
    "TOOLS:",
    toolList,
    "",
    "PROTOCOL — reply with EXACTLY ONE JSON object per turn, nothing else:",
    'To call a tool:   {"tool":"<name>","args":{...}}',
    'To answer/finish: {"answer":"<markdown reply to the user>"}',
    "",
    "Rules:",
    "- Output raw JSON only. No prose, no code fences, no commentary around it.",
    "- Call tools to look up ids before writing. Never invent an id.",
    "- When you have enough info or have completed the edit, return an answer.",
    "- Keep answers concise and in markdown.",
  ].join("\n");
}

export interface AgentEvent {
  type: "tool" | "final" | "error";
  tool?: string;
  args?: Record<string, unknown>;
  result?: unknown;
  text?: string;
}

function extractJson(s: string): Record<string, unknown> | null {
  const trimmed = s.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    // Fallback: grab the first {...} block.
    const m = trimmed.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        return JSON.parse(m[0]) as Record<string, unknown>;
      } catch {
        return null;
      }
    }
    return null;
  }
}

/**
 * Run the agent. `history` is prior turns (user/assistant). `onEvent` streams
 * tool calls + the final answer for the UI. Returns the final answer text.
 */
export async function runAgent(
  history: ChatMsg[],
  onEvent?: (e: AgentEvent) => void,
  signal?: AbortSignal,
): Promise<string> {
  const messages: ChatMsg[] = [{ role: "system", content: systemPrompt() }, ...history];

  for (let step = 0; step < MAX_STEPS; step++) {
    const completion = await rorkComplete(messages, signal);
    const parsed = extractJson(completion);

    if (!parsed) {
      // Model replied with plain prose — treat it as the final answer.
      onEvent?.({ type: "final", text: completion });
      return completion;
    }

    if (typeof parsed.answer === "string") {
      onEvent?.({ type: "final", text: parsed.answer });
      return parsed.answer;
    }

    if (typeof parsed.tool === "string") {
      const tool = TOOL_MAP.get(parsed.tool);
      const args = (parsed.args as Record<string, unknown>) ?? {};
      let result: unknown;
      if (!tool) {
        result = { error: `Unknown tool: ${parsed.tool}` };
      } else {
        try {
          result = tool.run(args);
        } catch (e) {
          result = { error: e instanceof Error ? e.message : String(e) };
        }
      }
      onEvent?.({ type: "tool", tool: parsed.tool, args, result });
      // Feed the tool call + its result back into the conversation.
      messages.push({ role: "assistant", content: JSON.stringify({ tool: parsed.tool, args }) });
      messages.push({ role: "user", content: `TOOL_RESULT ${parsed.tool}: ${JSON.stringify(result)}` });
      continue;
    }

    // Unrecognized JSON — return it as text.
    onEvent?.({ type: "final", text: completion });
    return completion;
  }

  const msg = "I couldn't complete that in a reasonable number of steps. Try rephrasing?";
  onEvent?.({ type: "final", text: msg });
  return msg;
}
