/**
 * Client-side prompt-token breakdown for the chat context ring — the mobile
 * analogue of desktop's `calculatePromptBreakdown` / `scaleBreakdown`
 * (electron/lib/llm.ts). Mobile runs its agent loop on-device and receives only
 * a flat `promptTokens` total from providers, so we reconstruct the per-category
 * split locally from the same ingredients the loop already has: the system
 * prompt, the advertised tool set (built-in vs external MCP/service), and the
 * conversation/tool-output history.
 *
 * Counts use the shared o200k_base counter (tokens.ts) — approximate for
 * non-OpenAI models, which is all a context-fill gauge needs. When the provider
 * reports a real prompt-token total, `scaleBreakdown` rescales the estimate so
 * the categories sum to that authoritative number.
 */

import { countTextTokens } from "./tokens";
import type { UIMessage } from "./providers/types";

/**
 * Client-side prompt-token estimate for a full request — the mobile analogue of
 * desktop's `calculatePromptBreakdown` total (electron/lib/llm.ts). Sums every
 * category (system + built-in tools + MCP/service tools + conversation +
 * tool-output overhead) so providers that don't report usage count the SAME
 * thing desktop does, instead of a rough text-only approximation.
 */
export function estimatePromptTokens(
  messages: UIMessage[],
  tools: Record<string, { description: string; jsonSchema: Record<string, unknown> }>,
): number {
  const b = computeBreakdown(messages, tools);
  return b.systemPrompt + b.tools + b.mcp + b.conversation + b.toolOutputs + b.skills + b.rules + b.subagentDefinitions;
}

/**
 * Per-category prompt-token counts. Mirrors desktop's TokenBreakdown
 * (src/types/index.ts) field-for-field so the two ring UIs stay in lock-step.
 * `rules`, `skills`, and `subagentDefinitions` are always 0 on mobile today
 * (no AGENTS-style rules injection, no `<available_skills>`, no subagent mode)
 * but are kept so the shape and future wiring match desktop exactly.
 */
export interface TokenBreakdown {
  systemPrompt: number;
  skills: number;
  tools: number;
  conversation: number;
  toolOutputs: number;
  rules: number;
  mcp: number;
  subagentDefinitions: number;
}

/** The tool shape the agent advertises (toolsForAgent()). */
type AgentToolMap = Record<string, { description: string; jsonSchema: Record<string, unknown> }>;

/** Concatenate the text of a message's parts (text parts only). */
function messageText(msg: UIMessage): string {
  const chunks: string[] = [];
  for (const p of msg.parts) {
    if (p.type === "text" && typeof (p as { text?: string }).text === "string") {
      chunks.push((p as { text: string }).text);
    }
  }
  return chunks.join("\n");
}

/**
 * Estimate the prompt-token breakdown from the on-device conversation + tools.
 *
 * - System prompt → `systemPrompt` (the first system message's text).
 * - Each tool def is JSON-stringified and counted; external tools (namespaced
 *   `mcp__…` or `svc__…`) go to `mcp`, built-ins to `tools` — matching the
 *   desktop split so the "MCP" segment reflects connected servers/services.
 * - Assistant/user text → `conversation`; assistant tool-call inputs and tool
 *   result outputs → `toolOutputs`.
 */
export function computeBreakdown(messages: UIMessage[], tools: AgentToolMap): TokenBreakdown {
  let systemPrompt = 0;
  let toolsTokens = 0;
  let mcpTokens = 0;
  let conversation = 0;
  let toolOutputs = 0;

  // 1. Tool definitions — built-in vs external (MCP servers / installed services).
  for (const [name, def] of Object.entries(tools)) {
    const toolStr = JSON.stringify({
      type: "function",
      function: { name, description: def.description ?? "", parameters: def.jsonSchema ?? {} },
    });
    if (name.startsWith("mcp__") || name.startsWith("svc__")) {
      mcpTokens += countTextTokens(toolStr);
    } else {
      toolsTokens += countTextTokens(toolStr);
    }
  }

  // 2. Messages — system prompt, conversation text, and tool call/result bytes.
  for (const msg of messages) {
    if (msg.role === "system") {
      systemPrompt += countTextTokens(messageText(msg));
      continue;
    }
    for (const p of msg.parts) {
      if (p.type === "text" && typeof (p as { text?: string }).text === "string") {
        conversation += countTextTokens((p as { text: string }).text);
      } else if (p.type.startsWith("tool-")) {
        // A tool part carries the call input and (once run) the output — both
        // occupy context and count as tool-output overhead, matching desktop.
        const tp = p as { input?: unknown; output?: unknown };
        if (tp.input !== undefined) toolOutputs += countTextTokens(safeStringify(tp.input));
        if (tp.output !== undefined) toolOutputs += countTextTokens(outputText(tp.output));
      }
    }
  }

  return {
    systemPrompt,
    skills: 0,
    tools: toolsTokens,
    conversation,
    toolOutputs,
    rules: 0,
    mcp: mcpTokens,
    subagentDefinitions: 0,
  };
}

function outputText(output: unknown): string {
  if (output && typeof output === "object" && (output as { type?: string }).type === "text") {
    return String((output as { value?: unknown }).value ?? "");
  }
  return safeStringify(output);
}

function safeStringify(v: unknown): string {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v) ?? "";
  } catch {
    return String(v);
  }
}

/** Sum of all category counts. */
export function breakdownTotal(b: TokenBreakdown): number {
  return (
    b.systemPrompt +
    b.skills +
    b.tools +
    b.conversation +
    b.toolOutputs +
    b.rules +
    b.mcp +
    b.subagentDefinitions
  );
}

/**
 * Rescale an estimated breakdown so its categories sum to `targetTotal` (the
 * provider's authoritative prompt-token count). No-op if either is non-positive.
 */
export function scaleBreakdown(breakdown: TokenBreakdown, targetTotal: number): TokenBreakdown {
  const sum = breakdownTotal(breakdown);
  if (sum <= 0 || targetTotal <= 0) return breakdown;
  const ratio = targetTotal / sum;
  return {
    systemPrompt: Math.round(breakdown.systemPrompt * ratio),
    skills: Math.round(breakdown.skills * ratio),
    tools: Math.round(breakdown.tools * ratio),
    conversation: Math.round(breakdown.conversation * ratio),
    toolOutputs: Math.round(breakdown.toolOutputs * ratio),
    rules: Math.round(breakdown.rules * ratio),
    mcp: Math.round(breakdown.mcp * ratio),
    subagentDefinitions: Math.round(breakdown.subagentDefinitions * ratio),
  };
}
