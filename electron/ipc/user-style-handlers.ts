/**
 * Cairn — IPC handlers for the user writing style (persona + full guide +
 * condensed cheat sheet). Backs Settings → Writing Style:
 *   - user-style:get / save / clear — the single-row table
 *   - user-style:generate — one-shot LLM generation for the guided wizard
 *     (full guide from persona+samples+answers, or cheat sheet from the guide)
 * The tool (get_user_writing_style) reads the same table in the main process.
 */

import { registerIpcHandle } from "./registry";
import { handle, type DbContext } from "./result-helpers";
import { getCachedConfig } from "../lib/config-cache";
import { isLocalEndpoint, normaliseBaseUrl, callLLM, type LLMConfig } from "../lib/llm";
import { resolveLlmApiKey } from "../lib/secure-store";
import {
  buildUserStyleFullGuidePrompt,
  buildUserStyleCheatsheetPrompt,
  type UserStyleGenerationInput,
} from "../lib/user-style-prompt";
import * as q from "../db/queries";
import type { UserStyleSaveInput } from "../db/user-style-queries";

/** Resolve the AI Chat connection (same semantics as ai-handlers.resolveConfig). */
function resolveChatConfig(): { error: string } | LLMConfig {
  const cached = getCachedConfig().aiConfig;
  const baseUrl = normaliseBaseUrl(cached?.baseUrl || "https://api.openai.com");
  const model = cached?.model || "gpt-5.6-luna";
  const keyRef = cached?.apiKey || "";
  const isLocal = isLocalEndpoint(baseUrl);
  if (!keyRef && !isLocal) {
    return { error: "AI is not configured. Add an API key in Settings → AI & Chat, or use a local endpoint." };
  }
  return { baseUrl, model, apiKey: resolveLlmApiKey(keyRef) };
}

export function registerUserStyleHandlers(ctx: DbContext): void {
  registerIpcHandle("user-style:get", () => handle(() => q.getUserStyle(ctx.db)));
  registerIpcHandle("user-style:save", (_e, { input }: { input: UserStyleSaveInput }) => handle(() => q.saveUserStyle(ctx.db, input)));
  registerIpcHandle("user-style:clear", () => handle(() => {
    q.clearUserStyle(ctx.db);
    return { ok: true };
  }));

  registerIpcHandle("user-style:generate", (_e, { step, input }: { step: "full" | "cheatsheet"; input: UserStyleGenerationInput }) =>
    handle(async () => {
      const cfg = resolveChatConfig();
      if ("error" in cfg) throw new Error(cfg.error);

      const systemPrompt =
        step === "full"
          ? "You are a writing-style analyst and editor. Produce a precise, evidence-based writing style guide from the user's real writing. Follow the structure in the user prompt exactly."
          : "You are a copy editor who condenses style guides into tight cheat sheets.";
      const userPrompt =
        step === "full"
          ? buildUserStyleFullGuidePrompt(input)
          : buildUserStyleCheatsheetPrompt(input.fullGuide ?? "");

      if (step === "cheatsheet" && !input.fullGuide) {
        throw new Error("No full guide to condense.");
      }

      const markdown = await callLLM(cfg, systemPrompt, userPrompt, {
        source: "writing-style",
      });
      return { markdown };
    }),
  );
}
