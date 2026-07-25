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
import { resolveLlmApiKey, isSecretRef } from "../lib/secure-store";

function resolveConfig(
  config: { baseUrl?: string; model?: string; apiKey?: string } | undefined,
  cacheKey: "ai" | "agent"
): { error: string } | LLMConfig {
  const cached = cacheKey === "ai" ? getCachedConfig().aiConfig : getCachedConfig().agentConfig;

  // Merge request config with cached config, always merging cached values if not
  // provided. `apiKey` here is a keychain reference token (or empty), not a raw key.
  const mergedConfig = {
    baseUrl: config?.baseUrl || cached?.baseUrl || "",
    model: config?.model || cached?.model || "",
    apiKey: config?.apiKey || cached?.apiKey || "",
  };

  const baseUrl = normaliseBaseUrl(mergedConfig.baseUrl || "https://api.openai.com");
  const model = mergedConfig.model || "gpt-4o-mini";
  const keyRef = mergedConfig.apiKey || "";
  const isLocal = isLocalEndpoint(baseUrl);
  if (!keyRef && !isLocal) {
    const sectionName = cacheKey === "ai" ? "Settings → AI & Chat" : "Settings";
    return { error: `AI is not configured. Add an API key in ${sectionName}, or use a local endpoint.` };
  }
  // Resolve the ref to the real key only now, for this request.
  return { baseUrl, model, apiKey: resolveLlmApiKey(keyRef) };
}

function cleanOutput(text: string): string {
  let cleaned = text.trim();

  // Detect and extract fenced block anywhere containing commit/PR keywords
  const fencedRegex = /```(?:[a-zA-Z]*\n)?([\s\S]*?(?:subject|body|title|description)[\s\S]*)```/i;
  const match = cleaned.match(fencedRegex);
  if (match) {
    return match[1].trim();
  }

  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```[a-zA-Z]*\n/, "").replace(/```$/, "").trim();
  }
  return cleaned;
}

function parseLLMResponse(
  result: string,
  headers: { primary: string; secondary: string },
  fallbacks: { primary: string; secondary: string }
): { primary: string; secondary: string } {
  const cleaned = cleanOutput(result);

  const primaryRegex = new RegExp(`(?:${headers.primary})(?:\\b|:|\\n|\\*\\*|#)*\\s*\\n?([\\s\\S]*?)(?:\\n\\s*(?:${headers.secondary})|$)`, "i");
  const secondaryRegex = new RegExp(`(?:${headers.secondary})(?:\\b|:|\\n|\\*\\*|#)*\\s*\\n?([\\s\\S]*)$`, "i");

  const primaryMatch = cleaned.match(primaryRegex);
  const secondaryMatch = cleaned.match(secondaryRegex);

  let primaryVal = primaryMatch?.[1]?.trim() ?? "";
  let secondaryVal = secondaryMatch?.[1]?.trim() ?? "";

  if (primaryVal) {
    primaryVal = primaryVal.replace(/^[:*#\s]+/, "").split("\n")[0].trim();
  }
  if (secondaryVal) {
    secondaryVal = secondaryVal.replace(/^[:*#\s]+/, "").trim();
  }

  if (!primaryVal && !secondaryVal) {
    const lines = cleaned.split("\n").filter(l => l.trim() !== "");
    if (lines.length > 0) {
      primaryVal = lines[0].replace(/^(subject|title|commit|pr)[:*#\s]*/i, "").trim();
      secondaryVal = lines.slice(1).join("\n").replace(/^(body|description)[:*#\s]*/i, "").trim();
    }
  }

  return {
    primary: primaryVal || fallbacks.primary,
    secondary: secondaryVal || fallbacks.secondary,
  };
}

export function registerAiHandlers(ctx: DbContext): void {
  registerIpcHandle("ai:localLLMStatus", async () => {
    return handle(async () => {
      const { isLocalLLMAvailable } = await import("../lib/local-llm");
      return await isLocalLLMAvailable();
    });
  });

  // ── Model discovery (GET {baseUrl}/v1/models) ─────
  // Runs in the main process so the API key (a keychain ref) is resolved here
  // and the raw key never lives in the renderer or crosses the CSP boundary.
  registerIpcHandle(
    "ai:fetchModels",
    async (_e, args: { baseUrl?: string; apiKey?: string }) =>
      handle(async () => {
        const url = normaliseBaseUrl(args.baseUrl || "https://api.openai.com");
        const realKey = resolveLlmApiKey(args.apiKey);
        const headers: Record<string, string> = {};
        if (realKey) headers["Authorization"] = `Bearer ${realKey}`;
        const res = await fetch(`${url}/v1/models`, { headers });
        if (!res.ok) throw new Error(`${res.status}`);
        const data = (await res.json()) as { data?: Array<{ id: string }> };
        return (data?.data ?? [])
          .map((m) => m.id)
          .filter((id) => !id.includes("embed") && !id.includes("whisper") && !id.includes("tts") && !id.includes("dall-e"))
          .sort();
      })
  );

  // ── AI PRD generation (direct, no chat loop) ──────
  registerIpcHandle("ai:generatePrd", async (_e, args: {
    projectId: string;
    title: string;
    requirements: string;
    config: { baseUrl: string; model: string; apiKey: string };
  }) => {
    // PRD returns its own { error } shape for user-facing validation errors.
    // Only persist a keychain ref to the cache — never a raw key.
    if (args.config?.apiKey && isSecretRef(args.config.apiKey)) {
      saveCachedConfig("ai", {
        baseUrl: args.config.baseUrl,
        model: args.config.model,
        apiKey: args.config.apiKey,
      });
    } else if (args.config?.baseUrl || args.config?.model) {
      saveCachedConfig("ai", { baseUrl: args.config.baseUrl, model: args.config.model });
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
      const parsed = parseLLMResponse(result, { primary: "SUBJECT", secondary: "BODY" }, { primary: "Update", secondary: "" });
      return { subject: parsed.primary, body: parsed.secondary };
    });
  });

  // ── AI PR description generation ──────────────────
  registerIpcHandle("ai:generatePrDescription", async (_e, args: {
    diff: string;
    config: { baseUrl: string; model: string; apiKey: string };
    template?: string;
  }) => {
    const resolved = resolveConfig(args.config, "agent");
    if ("error" in resolved) {
      return err(resolved.error);
    }

    return handle(async () => {
      const systemPrompt = "You are an expert at writing clear, detailed pull request descriptions. "
        + "Based on the provided git diff, generate a professional pull request title and a detailed markdown description. "
        + (args.template
            ? `You MUST format the DESCRIPTION using this markdown template:\n\n${args.template}\n\n`
            : "The description should include: Summary of changes, Context/Why, and Key changes list. ")
        + "Respond in this format:\n\nTITLE\n<title>\n\nDESCRIPTION\n<markdown description>\n\n";

      const userPrompt = `Generate a PR description for the following branch diff:\n\n${args.diff.slice(0, 8000)}`;
      const result = await callLLM(resolved, systemPrompt, userPrompt);
      const parsed = parseLLMResponse(result, { primary: "TITLE", secondary: "DESCRIPTION" }, { primary: "Pull Request", secondary: "" });
      return { title: parsed.primary, description: parsed.secondary };
    });
  });

  // ── AI architecture explanation (Module Map "Explain" action) ─────────────
  // Takes a compact, pre-computed description of the module graph (folder names,
  // sizes, and inter-module dependencies) — NOT source code — and returns a
  // short prose overview plus a one-line responsibility per module. Cheap +
  // privacy-friendly (only structure is sent).
  registerIpcHandle("ai:explainArchitecture", async (_e, args: {
    summary: string;
    config: { baseUrl: string; model: string; apiKey: string };
  }) => {
    const resolved = resolveConfig(args.config, "agent");
    if ("error" in resolved) {
      return err(resolved.error);
    }
    return handle(async () => {
      const systemPrompt =
        "You are a senior engineer explaining a codebase's architecture to a new teammate. "
        + "You are given a project's module structure: top-level folders (modules) with their file/symbol counts and the dependencies between them. "
        + "Infer each module's likely responsibility from its name, size and dependencies. "
        + "Respond in this exact format:\n\n"
        + "OVERVIEW\n<2-4 sentence plain-English summary of what this project is and how it's structured>\n\n"
        + "MODULES\n<one line per module: `- name — its responsibility in <=12 words`>\n\n"
        + "Be concise and concrete. Do not invent modules that aren't listed.";
      const userPrompt = `Explain this project's architecture:\n\n${args.summary.slice(0, 6000)}`;
      const result = await callLLM(resolved, systemPrompt, userPrompt);
      const parsed = parseLLMResponse(result, { primary: "OVERVIEW", secondary: "MODULES" }, { primary: "", secondary: "" });
      return { overview: parsed.primary, modules: parsed.secondary };
    });
  });
}
