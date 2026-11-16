/**
 * Chat entry points: chat turns, ask answers, compaction. (F5/B4: split out of
 * `electron/ipc/engine-bridge.ts`; no logic changes.)
 */
import type { DbContext } from "../result-helpers";
import { broadcastEvent } from "../registry";
import { getEngineHost } from "./host";
import { runEnginePrompt } from "./prompt";
import { chatApprovalPolicyFor, chatSystemPrompt } from "./permissions";
import type { Attachment } from "../../agent/attachments";
import type { ChatRequest } from "../../lib/tools";
import type { AgentLLMConfig } from "../../lib/session-runtime-types";
import { makeSessionProjection } from "../../../shared/agent/session-projection";
import { rejectBusy } from "../session-guards";
import { routeFromConfig } from "../../agent/route";

/** A chat turn on the engine. Mirrors the checks `runChatPrompt` makes before it starts. */
export async function runEngineChat(ctx: DbContext, req: ChatRequest): Promise<void> {
  const sessionId = `chat-${req.threadId}`;
  const h = getEngineHost(ctx);
  if (h.isRunning(sessionId)) {
    rejectBusy(sessionId, "Session is busy — please wait for the current turn to finish.");
    return;
  }
  // Lazy: chat.ts pulls in the pop-out window module, which needs a live Electron `app` at import time.
  const { resolveAIConfig } = await import("../chat");
  // No key is not refused here: a self-hosted provider on the network needs none, and a hosted one
  // that does answers with its own error, which is shown in plain words.
  const { provider, baseUrl, model, apiKey } = resolveAIConfig(req.config);
  const policy = chatApprovalPolicyFor(req);
  await runEnginePrompt({
    ctx, sessionId, prompt: req.message, cwd: ctx.workspacePath, attachments: req.images as Attachment[] | undefined,
    projectId: req.projectId, workspaceId: req.workspaceId,
    systemPrompt: chatSystemPrompt(req, policy),
    llmConfig: {
      baseUrl, model, apiKey, provider,
      maxSteps: req.config?.maxSteps ?? 30,
      temperature: req.config?.temperature,
      maxTokens: req.config?.maxTokens,
      contextWindow: req.config?.contextLimit ?? req.config?.contextWindow,
      reasoningEffort: req.config?.reasoningEffort,
      isReasoningModel: req.config?.isReasoningModel,
      apiMode: req.config?.apiMode,
    } as AgentLLMConfig,
    chat: { req, policy },
  });
}

/** Answer an ask raised by a headless run. */
export function respondEngineAsk(ctx: DbContext, sessionId: string, callId: string, nonce: string | undefined, decision: { approved: boolean; grant?: "session" | "command" | "workspace" }): boolean {
  return getEngineHost(ctx).respondTool(sessionId, callId, nonce, decision);
}

/** `/compact`: fold the older history of a coding or chat session now. */
export async function compactEngineSession(ctx: DbContext, args: { sessionId: string; cwd: string; llmConfig: AgentLLMConfig }): Promise<"compacted" | "nothing" | "busy"> {
  const h = getEngineHost(ctx);
  if (h.isRunning(args.sessionId)) return "busy";
  broadcastEvent("session:projection", makeSessionProjection(args.sessionId, "compact", { status: "start" }));
  try {
    return (await h.compact(args.sessionId, args.cwd, routeFromConfig(args.llmConfig))) ? "compacted" : "nothing";
  } catch (err) {
    broadcastEvent("session:projection", makeSessionProjection(args.sessionId, "compact", { status: "end" }));
    throw err;
  }
}
