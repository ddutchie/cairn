/**
 * Cairn — IPC handlers for AI features (`ai:*` channels).
 *
 * - `ai:localLLMStatus` — probe whether a local llama.cpp binary is installed.
 * - `ai:generatePrd`    — one-shot PRD generation (no chat loop, returns text).
 *
 * Extracted from the god-file `ipc/handlers.ts` (P2 of the cleanup plan).
 */

import { registerIpcHandle } from "./registry";
import { err, handle, type DbContext } from "./result-helpers";
import { generatePrd } from "../lib/prd";
import { callLLM, isLocalEndpoint, normaliseBaseUrl, type LLMConfig } from "../lib/llm";
import { saveCachedConfig, getCachedConfig } from "../lib/config-cache";

export function registerAiHandlers(ctx: DbContext): void {
  registerIpcHandle("ai:localLLMStatus", async () => {
    return handle(async () => {
      const { isLocalLLMAvailable } = await import("../lib/local-llm");
      return await isLocalLLMAvailable();
    });
  });

  // ── AI PRD generation (direct, no chat loop) ──────
  registerIpcHandle("ai:generatePrd", async (_e, args: {
    projectId: string;
    title: string;
    requirements: string;
    config: { baseUrl: string; model: string; apiKey: string };
  }) => {
    // PRD returns its own { error } shape for user-facing validation errors
    if (args.config?.apiKey) {
      saveCachedConfig("ai", {
        baseUrl: args.config.baseUrl,
        model: args.config.model,
        apiKey: args.config.apiKey,
      });
    }

    let reqConfig: { baseUrl?: string; model?: string; apiKey?: string } = args.config;
    if (!reqConfig?.apiKey) {
      const cached = getCachedConfig().aiConfig;
      if (cached?.apiKey) {
        reqConfig = {
          ...reqConfig,
          baseUrl: reqConfig?.baseUrl || cached.baseUrl,
          model: reqConfig?.model || cached.model,
          apiKey: cached.apiKey,
        };
      }
    }

    const baseUrl = normaliseBaseUrl(reqConfig?.baseUrl || "https://api.openai.com");
    const model = reqConfig?.model || "gpt-4o-mini";
    const apiKey = reqConfig?.apiKey || "";
    const isLocal = isLocalEndpoint(baseUrl);
    if (!apiKey && !isLocal) {
      return err("AI is not configured. Add an API key in Settings → AI & Chat, or use a local endpoint.");
    }
    const llmConfig = { baseUrl, model, apiKey };
    return handle(() => generatePrd(ctx.db, ctx.workspacePath, {
      projectId: args.projectId,
      title: args.title,
      requirements: args.requirements,
    }, llmConfig));
  });

  // ── AI commit message generation ──────────────────
  registerIpcHandle("ai:generateCommitMessage", async (_e, args: {
    diff: string;
    config: { baseUrl: string; model: string; apiKey: string };
  }) => {
    let reqConfig = args.config;
    if (!reqConfig?.apiKey) {
      const cached = getCachedConfig().agentConfig;
      if (cached?.apiKey) {
        reqConfig = {
          ...reqConfig,
          baseUrl: reqConfig?.baseUrl || cached.baseUrl || "",
          model: reqConfig?.model || cached.model || "",
          apiKey: cached.apiKey,
        };
      }
    }

    const baseUrl = normaliseBaseUrl(reqConfig?.baseUrl || "https://api.openai.com");
    const model = reqConfig?.model || "gpt-4o-mini";
    const apiKey = reqConfig?.apiKey || "";
    const isLocal = isLocalEndpoint(baseUrl);
    if (!apiKey && !isLocal) {
      return err("AI is not configured. Add an API key in Settings.");
    }
    const llmConfig: LLMConfig = { baseUrl, model, apiKey };

    return handle(async () => {
      const systemPrompt = "You are an expert at writing clear, concise git commit messages. "
        + "Generate a commit message with a short subject line (≤72 chars) and a detailed body. "
        + "Respond in this format:\n\nSUBJECT\n<subject>\n\nBODY\n<body>\n\n"
        + "The subject should be formatted as conventional commits: type(scope): description. "
        + "Use types: feat, fix, refactor, chore, docs, style, test, perf.";

      const userPrompt = `Generate a commit message for the following diff:\n\n${args.diff.slice(0, 8000)}`;
      const result = await callLLM(llmConfig, systemPrompt, userPrompt);
      const subjectMatch = result.match(/SUBJECT\n(.+?)(?:\n|$)/);
      const bodyMatch = result.match(/BODY\n([\s\S]*?)$/);
      const subject = subjectMatch?.[1]?.trim() ?? "Update";
      const body = bodyMatch?.[1]?.trim() ?? "";
      return { subject, body };
    });
  });
}
