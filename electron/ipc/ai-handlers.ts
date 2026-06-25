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

function resolveConfig(
  config: { baseUrl?: string; model?: string; apiKey?: string } | undefined,
  cacheKey: "ai" | "agent"
): { error: string } | LLMConfig {
  const cached = cacheKey === "ai" ? getCachedConfig().aiConfig : getCachedConfig().agentConfig;

  // Merge request config with cached config, always merging cached values if not provided.
  const mergedConfig = {
    baseUrl: config?.baseUrl || cached?.baseUrl || "",
    model: config?.model || cached?.model || "",
    apiKey: config?.apiKey || cached?.apiKey || "",
  };

  const baseUrl = normaliseBaseUrl(mergedConfig.baseUrl || "https://api.openai.com");
  const model = mergedConfig.model || "gpt-4o-mini";
  const apiKey = mergedConfig.apiKey || "";
  const isLocal = isLocalEndpoint(baseUrl);
  if (!apiKey && !isLocal) {
    const sectionName = cacheKey === "ai" ? "Settings → AI & Chat" : "Settings";
    return { error: `AI is not configured. Add an API key in ${sectionName}, or use a local endpoint.` };
  }
  return { baseUrl, model, apiKey };
}

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

    const resolved = resolveConfig(args.config, "ai");
    if ("error" in resolved) {
      return err(resolved.error);
    }

    return handle(() => generatePrd(ctx.db, ctx.workspacePath, {
      projectId: args.projectId,
      title: args.title,
      requirements: args.requirements,
    }, resolved));
  });

  // ── AI commit message generation ──────────────────
  registerIpcHandle("ai:generateCommitMessage", async (_e, args: {
    diff: string;
    config: { baseUrl: string; model: string; apiKey: string };
  }) => {
    const resolved = resolveConfig(args.config, "agent");
    if ("error" in resolved) {
      return err(resolved.error);
    }

    return handle(async () => {
      const systemPrompt = "You are an expert at writing clear, concise git commit messages. "
        + "Generate a commit message with a short subject line (≤72 chars) and a detailed body. "
        + "Respond in this format:\n\nSUBJECT\n<subject>\n\nBODY\n<body>\n\n"
        + "The subject should be formatted as conventional commits: type(scope): description. "
        + "Use types: feat, fix, refactor, chore, docs, style, test, perf.";

      const userPrompt = `Generate a commit message for the following diff:\n\n${args.diff.slice(0, 8000)}`;
      const result = await callLLM(resolved, systemPrompt, userPrompt);
      const subjectMatch = result.match(/SUBJECT\n(.+?)(?:\n|$)/);
      const bodyMatch = result.match(/BODY\n([\s\S]*?)$/);
      const subject = subjectMatch?.[1]?.trim() ?? "Update";
      const body = bodyMatch?.[1]?.trim() ?? "";
      return { subject, body };
    });
  });

  // ── AI PR description generation ──────────────────
  registerIpcHandle("ai:generatePrDescription", async (_e, args: {
    diff: string;
    config: { baseUrl: string; model: string; apiKey: string };
  }) => {
    const resolved = resolveConfig(args.config, "agent");
    if ("error" in resolved) {
      return err(resolved.error);
    }

    return handle(async () => {
      const systemPrompt = "You are an expert at writing clear, detailed pull request descriptions. "
        + "Based on the provided git diff, generate a professional pull request title and a detailed markdown description. "
        + "The description should include: Summary of changes, Context/Why, and Key changes list. "
        + "Respond in this format:\n\nTITLE\n<title>\n\nDESCRIPTION\n<markdown description>\n\n";

      const userPrompt = `Generate a PR description for the following branch diff:\n\n${args.diff.slice(0, 8000)}`;
      const result = await callLLM(resolved, systemPrompt, userPrompt);
      const titleMatch = result.match(/TITLE\n(.+?)(?:\n|$)/);
      const descMatch = result.match(/DESCRIPTION\n([\s\S]*?)$/);
      const title = titleMatch?.[1]?.trim() ?? "Pull Request";
      const description = descMatch?.[1]?.trim() ?? "";
      return { title, description };
    });
  });
}
