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

/**
 * Cheap coherence check: a generated style guide must contain a sensible number
 * of markdown headings. A failed generation degrades into "token soup" — long
 * scrambled fragments with almost no structure — and this catches that before
 * it reaches the preview. Thresholds are deliberately low (the full guide asks
 * for 12 sections, the cheat sheet for ~8).
 */
/** Exported for tests. */
export function countHeadings(markdown: string): number {
  const m = markdown.match(/^\s*#{1,2}\s+/gm);
  return m ? m.length : 0;
}

/** Exported for tests. */
export function isUsableGuide(markdown: string, step: "full" | "cheatsheet"): boolean {
  const headings = countHeadings(markdown);
  if (step === "full") return headings >= 6;
  return headings >= 3;
}

/**
 * Run a style-guide generation with the handler's exact resilience: build the
 * prompt, call the LLM (bounded output, lower temperature), and if the result
 * fails the coherence gate retry once at temp 0.1. Throws a clear error if both
 * attempts are unusable. Exported so the live test drives the same code path
 * the wizard uses.
 */
export async function generateUserStyleMarkdown(
  cfg: LLMConfig,
  step: "full" | "cheatsheet",
  input: UserStyleGenerationInput,
): Promise<string> {
  const systemPrompt =
    step === "full"
      ? "You are a writing-style analyst and editor. Produce a precise, evidence-based writing style guide from the user's real writing. Follow the structure in the user prompt exactly. Write in clean, well-formed Markdown with ## headings — never splice or garble the user's words."
      : "You are a copy editor who condenses style guides into tight cheat sheets. Write in clean, well-formed Markdown with headings — never splice or garble the source text.";
  const userPrompt =
    step === "full"
      ? buildUserStyleFullGuidePrompt(input)
      : buildUserStyleCheatsheetPrompt(input.fullGuide ?? "");

  if (step === "cheatsheet" && !input.fullGuide) {
    throw new Error("No full guide to condense.");
  }

  let markdown = await callLLM(cfg, systemPrompt, userPrompt, {
    source: "writing-style",
    temperature: 0.3,
    maxTokens: 8192,
  });
  if (!isUsableGuide(markdown, step)) {
    markdown = await callLLM(cfg, systemPrompt, userPrompt, {
      source: "writing-style",
      temperature: 0.1,
      maxTokens: 8192,
    });
  }
  if (!isUsableGuide(markdown, step)) {
    throw new Error(
      `The model (${cfg.model}) returned unusable output for the style guide. Try again, or switch to a more capable model in Settings → AI & Chat.`,
    );
  }
  return markdown;
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
      const markdown = await generateUserStyleMarkdown(cfg, step, input);
      return { markdown };
    }),
  );
}
