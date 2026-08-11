/**
 * Cairn — IPC handlers for the user writing style (persona + full guide +
 * condensed cheat sheet). Backs Settings → Writing Style:
 *   - user-style:get / save / clear — the single-row table
 *   - user-style:generate — one-shot LLM generation for the guided wizard
 *     (full guide from persona+samples+answers, or cheat sheet from the guide)
 * The tool (get_user_writing_style) reads the same table in the main process.
 */

import { registerIpcHandle, registerIpcOn } from "./registry";
import { handle, type DbContext } from "./result-helpers";
import { getCachedConfig } from "../lib/config-cache";
import { isLocalEndpoint, normaliseBaseUrl, callLLM, type LLMConfig } from "../lib/llm";
import { resolveLlmApiKey } from "../lib/secure-store";
import {
  buildUserStyleFullGuidePrompt,
  buildUserStyleCheatsheetPrompt,
  buildUserStyleOptimizePrompt,
  type UserStyleGenerationInput,
} from "../lib/user-style-prompt";
import { runToolLoop } from "../lib/chat-loop";
import { TOOLS } from "../lib/tools";
import * as q from "../db/queries";
import type { UserStyleSaveInput } from "../db/user-style-queries";

/**
 * Read-only tool set for the "analyse my notes & tasks" generation path. The
 * model may search/read the user's actual notes and tasks to ground the guide —
 * nothing else. No get_active_context (IDs are passed in the prompt), no write
 * tools, so generation can never mutate anything.
 */
const WRITING_STYLE_TOOLS = new Set([
  "get_project_context_pack",
  "search_notes",
  "get_note",
  "search_tasks",
  "get_task",
]);

function writingStyleToolsOverride(analyseNotes: boolean) {
  if (!analyseNotes) return [] as typeof TOOLS;
  return TOOLS.filter((t) => WRITING_STYLE_TOOLS.has(t.function.name));
}

const abortControllers = new Map<number, AbortController>();

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
export type UserStyleStep = "full" | "cheatsheet" | "optimize";

export function isUsableGuide(markdown: string, step: UserStyleStep): boolean {
  const headings = countHeadings(markdown);
  if (step === "cheatsheet") return headings >= 3;
  return headings >= 6;
}

const PROMPT_SYSTEM: Record<"full" | "cheatsheet" | "optimize", string> = {
  full: "You are a writing-style analyst and editor. Produce a precise, evidence-based writing style guide from the user's real writing. Follow the structure in the user prompt exactly. Write in clean, well-formed Markdown with ## headings — never splice or garble the user's words.",
  cheatsheet: "You are a copy editor who condenses style guides into tight cheat sheets. Write in clean, well-formed Markdown with headings — never splice or garble the source text.",
  optimize: "You are an editor who restructures existing writing style guides into a canonical, optimized format. Write in clean, well-formed Markdown with ## headings — never splice or garble the source text.",
};

/** Build the { system, user } prompt pair for a generation step (shared by the
 *  one-shot and streaming paths so they can never drift). */
export function buildUserStylePromptPair(
  step: UserStyleStep,
  input: UserStyleGenerationInput,
): { systemPrompt: string; userPrompt: string } {
  const userPrompt =
    step === "full"
      ? buildUserStyleFullGuidePrompt(input)
      : step === "cheatsheet"
        ? buildUserStyleCheatsheetPrompt(input.fullGuide ?? "")
        : buildUserStyleOptimizePrompt(input.fullGuide ?? "");
  return { systemPrompt: PROMPT_SYSTEM[step], userPrompt };
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
  step: UserStyleStep,
  input: UserStyleGenerationInput,
): Promise<string> {
  const { systemPrompt, userPrompt } = buildUserStylePromptPair(step, input);

  if ((step === "cheatsheet" || step === "optimize") && !input.fullGuide) {
    throw new Error(step === "cheatsheet" ? "No full guide to condense." : "No full guide to optimize.");
  }

  let markdown = await callLLM(cfg, systemPrompt, userPrompt, {
    source: "writing-style",
    temperature: 0.3,
    maxTokens: 8192,
    // Non-streaming: some gateways garble SSE output when a reasoning model
    // interleaves long reasoning_content deltas with content deltas (verified
    // against zen/go — same request is clean non-streamed, soup streamed).
    stream: false,
  });
  if (!isUsableGuide(markdown, step)) {
    markdown = await callLLM(cfg, systemPrompt, userPrompt, {
      source: "writing-style",
      temperature: 0.1,
      maxTokens: 8192,
      stream: false,
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

  registerIpcHandle("user-style:generate", (_e, { step, input }: { step: UserStyleStep; input: UserStyleGenerationInput }) =>
    handle(async () => {
      const cfg = resolveChatConfig();
      if ("error" in cfg) throw new Error(cfg.error);
      const markdown = await generateUserStyleMarkdown(cfg, step, input);
      return { markdown };
    }),
  );

  // user-style:generateStream — fire-and-forget streaming generation for the
  // wizard so the guide (and any note-reading tool calls) appear live.
  // Emits:
  //   user-style:token        { delta }            — one content chunk
  //   user-style:tool-call    { tool, label, args } — a note/task read (analyse path)
  //   user-style:done         { content, usable, error? }
  registerIpcOn("user-style:generateStream", (event, req: {
    config?: { baseUrl?: string; model?: string; apiKey?: string };
    workspaceId?: string;
    projectId?: string;
    projectName?: string;
    step: UserStyleStep;
    analyseNotes: boolean;
    input: UserStyleGenerationInput;
  }) => {
    abortControllers.get(event.sender.id)?.abort();
    const abortCtrl = new AbortController();
    abortControllers.set(event.sender.id, abortCtrl);

    const send = (ch: string, payload: unknown) => {
      if (!event.sender.isDestroyed()) event.sender.send(ch, payload);
    };

    void (async () => {
      try {
        const cfg = resolveChatConfig();
        if ("error" in cfg) {
          send("user-style:done", { content: "", usable: false, error: cfg.error });
          return;
        }

        // Build the generation prompt pair (shared with the one-shot path).
        const { systemPrompt, userPrompt: baseUserPrompt } = buildUserStylePromptPair(req.step, req.input);
        const scopeHint = req.projectName
          ? `\n\n## Active context\nProject: ${req.projectName}\nWorkspace ID: ${req.workspaceId ?? ""}\nProject ID: ${req.projectId ?? ""}\nIf you need the user's own content, search/read their notes and tasks with the tools (scope searches to the project ID). Do NOT call get_active_context — the IDs are above. Never call write tools.`
          : "";
        const userPrompt = baseUserPrompt + scopeHint;
        if ((req.step === "cheatsheet" || req.step === "optimize") && !req.input.fullGuide) {
          send("user-style:done", { content: "", usable: false, error: req.step === "cheatsheet" ? "No full guide to condense." : "No full guide to optimize." });
          return;
        }

        const chatReq = {
          message: userPrompt,
          threadId: "user-style",
          workspaceId: req.workspaceId,
          projectId: req.projectId,
          config: { maxSteps: 6, temperature: 0.3 },
        };
        const messages = [
          { role: "system" as const, content: systemPrompt },
          { role: "user" as const, content: userPrompt },
        ];
        const toolsOverride = writingStyleToolsOverride(req.analyseNotes);

        const run = async () => {
          const result = await runToolLoop(
            ctx.db, chatReq as never, ctx.workspacePath,
            cfg.baseUrl, cfg.model, cfg.apiKey,
            messages,
            (e) => send("user-style:tool-call", e),
            abortCtrl.signal, undefined, "openai",
            undefined,
            (e) => send("user-style:tool-call-done", e),
            (delta) => send("user-style:token", { delta }),
            undefined,
            [],
            toolsOverride,
          );
          return result.content;
        };

        let content = await run();
        if (!isUsableGuide(content, req.step)) {
          // Retry once — non-deterministic models occasionally degrade.
          content = await run();
        }
        send("user-style:done", {
          content,
          usable: isUsableGuide(content, req.step),
          error: isUsableGuide(content, req.step)
            ? undefined
            : `The model (${cfg.model}) returned unusable output for the style guide. Try again, or switch to a more capable model in Settings → AI & Chat.`,
        });
      } catch (err) {
        if (abortCtrl.signal.aborted) return; // user cancelled — no event
        send("user-style:done", {
          content: "",
          usable: false,
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        abortControllers.delete(event.sender.id);
      }
    })();
  });

  registerIpcOn("user-style:abort", (event) => {
    abortControllers.get(event.sender.id)?.abort();
    abortControllers.delete(event.sender.id);
  });
}
