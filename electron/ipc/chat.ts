/**
 * Cairn — AI Chat IPC handler
 *
 * Chat-adjacent one-shot handlers (compact a thread, summarise a transcript) and
 * the shared connection resolver the engine uses for chat turns.
 */

import { registerContractHandle } from "./registry";
import { handle } from "./result-helpers";
import type { DbContext } from "./result-helpers";
import { resolveConnection } from "../lib/llm-config";
import { getEngineHost } from "./engine-bridge";
import { routeFromConfig } from "../agent/route";
import { runOneShot } from "../agent/one-shot";

export function resolveAIConfig(config?: {
  provider?: string;
  baseUrl?: string;
  model?: string;
  apiKey?: string;
}): {
  provider: string;
  baseUrl: string;
  model: string;
  apiKey: string;
} {
  // Single home for the chat cached-key rule (lib/llm-config.ts): the cached
  // key is reused only for the same endpoint, never for local.
  return resolveConnection("ai", config);
}

// Re-export for backward compatibility (prd.ts and others import LLMConfig from here)
export type { LLMConfig } from "../lib/llm";

/**
 * Registers the chat streaming channels.
 *
 * Reads `db` / `workspacePath` from `ctx` at CALL time, never at registration
 * time, so `reinitialise()` swapping the workspace is transparent. Capturing
 * them by value here is what previously left a freshly-onboarded workspace's
 * chat bound to the throwaway boot DB until the app was restarted.
 */
export function registerChatHandler(ctx: DbContext): void {
  registerContractHandle("chat:compactThread", (_event, req) => handle(async () => {
      const { baseUrl, model, apiKey } = resolveAIConfig(req.config);
      const threadId = req.threadId;
      if (!threadId) throw new Error("compact: threadId required");

      const h = getEngineHost(ctx);
      const sessionId = `chat-${threadId}`;
      if (h.isRunning(sessionId)) throw new Error("compact: the thread is busy");
      const route = routeFromConfig({ baseUrl, model, apiKey, provider: "openai", apiMode: req.config.apiMode } as never);
      const compacted = await h.compact(sessionId, ctx.workspacePath, route);
      return { compacted };
  }));

  // One-shot summary of a chat transcript, for archiving a thread into a note.
  // Unlike chat:compactThread it reads only the messages it's given and leaves
  // the session log alone.
  registerContractHandle("chat:summarizeTranscript", (_event, req) => handle(async () => {
    const { baseUrl, model, apiKey } = resolveAIConfig(req.config);
    const turns = req.messages
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`);
    if (!turns.join("").trim()) throw new Error("Nothing to summarise.");
    // Keep the most recent whole messages of very long threads within a sane
    // prompt size, and tell the model when the start was dropped.
    const MAX_CHARS = 60_000;
    const kept: string[] = [];
    let size = 0;
    for (let i = turns.length - 1; i >= 0; i--) {
      if (kept.length > 0 && size + turns[i].length > MAX_CHARS) break;
      kept.unshift(turns[i]);
      size += turns[i].length;
    }
    const dropped = turns.length - kept.length;
    const clipped = (dropped > 0 ? `[${dropped} earlier messages omitted]\n\n` : "") + kept.join("\n\n");
    const summary = await runOneShot({
      systemPrompt: "You summarise conversations for a project notebook. Write clear markdown: a short overview paragraph, then bullet points for decisions, findings and open questions. No preamble.",
      userPrompt: `Summarise this conversation:\n\n${clipped}`,
      config: { baseUrl, model, apiKey, provider: "openai", apiMode: req.config.apiMode },
      source: "summary",
      projectId: req.projectId,
      workspaceId: req.workspaceId,
    });
    if (!summary.trim()) throw new Error("The model returned an empty summary.");
    return { summary: summary.trim() };
  }));

}
