/**
 * Cairn — IPC handlers for the user writing style (persona + full guide +
 * condensed cheat sheet). Backs Settings → Writing Style:
 *   - user-style:get / save / clear — the single-row table
 *   - user-style:generate — one-shot LLM generation for the guided wizard
 *     (full guide from persona+samples+answers, or cheat sheet from the guide)
 * The tool (get_user_writing_style) reads the same table in the main process.
 */

import { registerContractHandle, registerIpcOn, sendIpcEvent } from "./registry";
import type { IpcEventArgs, IpcEvents } from "../../shared/ipc/contract";
import type { UserStyleStreamRequest } from "../../shared/types/user-style";
import { handle, type DbContext } from "./result-helpers";
import { getCachedConfig } from "../lib/config-cache";
import { isLocalEndpoint, normaliseBaseUrl, type LLMConfig } from "../lib/llm";
import { resolveLlmApiKey } from "../lib/secure-store";
import {
  buildUserStyleFullGuidePrompt,
  buildUserStyleCheatsheetPrompt,
  buildUserStyleOptimizePrompt,
  type UserStyleGenerationInput,
} from "../lib/user-style-prompt";
import { randomBytes } from "node:crypto";
import type { HostSend } from "../agent/host";
import { forgetEngineSession, getEngineHost, runEngineTapped } from "./engine-bridge";
import { TOOLS } from "../lib/tools";
import * as q from "../db/queries";
import { errMsg } from "../host-shared/errors";

/**
 * Read-only tool set for the "analyse my notes & tasks" generation path. The
 * model may search/read the user's actual notes and tasks to ground the guide —
 * nothing else. IDs are passed in the prompt, no write
 * tools, so generation can never mutate anything.
 */
export const WRITING_STYLE_TOOLS = new Set([
  "get_context",
  "search_notes",
  "get_item",
  "search_tasks",
]);

/** Read-only TOOLS subset for the analyse path (exported for the live test). */
export function writingStyleToolsOverride(analyseNotes: boolean) {
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
  // Pin the protocol from the active saved provider (see ai-handlers.resolveConfig).
  const apiMode = cached?.savedProviders?.find((p) => p.id === cached?.activeProviderId)?.apiMode as ("responses" | "completions" | "anthropic-messages" | undefined);
  return { baseUrl, model, apiKey: resolveLlmApiKey(keyRef), apiMode };
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
export type { UserStyleStep } from "../../shared/types/user-style";
import type { UserStyleStep } from "../../shared/types/user-style";

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
 * prompt, call the LLM (bounded output, lower temperature), and if the call
 * fails or the result fails the coherence gate retry once at temp 0.1. Throws
 * the second call's error, or a clear error if both attempts are unusable. Exported so the live test drives the same code path
 * the wizard uses.
 */
export async function generateUserStyleMarkdown(
  cfg: LLMConfig,
  step: UserStyleStep,
  input: UserStyleGenerationInput,
): Promise<string> {
  // Validate the precondition BEFORE building a prompt from a possibly-empty
  // source guide.
  if ((step === "cheatsheet" || step === "optimize") && !input.fullGuide) {
    throw new Error(step === "cheatsheet" ? "No full guide to condense." : "No full guide to optimize.");
  }
  const { systemPrompt, userPrompt } = buildUserStylePromptPair(step, input);

  // One-shot (single-turn, no tools) on the configured provider.
  const { runOneShot } = await import("../agent/one-shot");
  // A failed first attempt (e.g. a degenerate empty completion, which
  // runOneShot rejects as EMPTY_RESPONSE) gets the same single retry as an
  // unusable one; a second failure propagates.
  let markdown = await runOneShot({
    systemPrompt, userPrompt,
    config: cfg,
    source: "writing-style",
    maxTokens: 8192,
    temperature: 0.3,
  }).catch((err: unknown) => {
    console.warn("[user-style] first attempt failed, retrying", err);
    return "";
  });
  if (!isUsableGuide(markdown, step)) {
    markdown = await runOneShot({
      systemPrompt, userPrompt,
      config: cfg,
      source: "writing-style",
      maxTokens: 8192,
      temperature: 0.1,
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
  registerContractHandle("user-style:get", () => handle(() => q.getUserStyle(ctx.db)));
  registerContractHandle("user-style:save", (_e, { input }) => handle(() => q.saveUserStyle(ctx.db, input)));
  registerContractHandle("user-style:clear", () => handle(() => {
    q.clearUserStyle(ctx.db);
    return { ok: true as const };
  }));

  registerContractHandle("user-style:generate", (_e, { step, input }) =>
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
  registerIpcOn("user-style:generateStream", (event, req: UserStyleStreamRequest) => {
    abortControllers.get(event.sender.id)?.abort();
    const abortCtrl = new AbortController();
    abortControllers.set(event.sender.id, abortCtrl);

    const send = <E extends "user-style:token" | "user-style:tool-call" | "user-style:tool-call-done" | "user-style:done">(
      ch: E, payload: IpcEvents[E],
    ) => {
      if (!event.sender.isDestroyed()) sendIpcEvent(event.sender, ch, ...([payload] as IpcEventArgs<E>));
    };

    void (async () => {
      try {
        const cfg = resolveChatConfig();
        if ("error" in cfg) {
          send("user-style:done", { content: "", usable: false, error: cfg.error });
          return;
        }

        // Validate the precondition BEFORE building a prompt from a possibly
        // empty source guide.
        if ((req.step === "cheatsheet" || req.step === "optimize") && !req.input.fullGuide) {
          send("user-style:done", { content: "", usable: false, error: req.step === "cheatsheet" ? "No full guide to condense." : "No full guide to optimize." });
          return;
        }

        // Build the generation prompt pair (shared with the one-shot path).
        const { systemPrompt, userPrompt: baseUserPrompt } = buildUserStylePromptPair(req.step, req.input);
        const scopeHint = req.projectName
          ? `\n\n## Active context\nProject: ${req.projectName}\nWorkspace ID: ${req.workspaceId ?? ""}\nProject ID: ${req.projectId ?? ""}\nIf you need the user's own content, search/read their notes and tasks with the tools (scope searches to the project ID). Do NOT call get_active_context — the IDs are above. Never call write tools.`
          : "";
        const userPrompt = baseUserPrompt + scopeHint;

        const allowTools: ReadonlySet<string> = req.analyseNotes ? WRITING_STYLE_TOOLS : new Set<string>();
        const engineCtx = ctx;

        const run = async () => {
          const sessionId = `user-style-${randomBytes(6).toString("hex")}`;
          let content = "";
          const tap: HostSend = (channel, payload) => {
            if (channel !== "session:event") return;
            const event = (payload as { event: { type: string; data: Record<string, unknown> } }).event;
            if (event.type === "assistant/chunk") {
              const chunk = event.data.chunk as { type: string; text?: string };
              if (chunk.type === "text-delta" && chunk.text) send("user-style:token", { delta: chunk.text });
            } else if (event.type === "assistant/message") {
              const parts = ((event.data.message as { content?: Array<{ type: string; text?: string }> }).content ?? []);
              content = parts.filter((p) => p.type === "text").map((p) => p.text ?? "").join("");
            } else if (event.type === "tool/call") {
              send("user-style:tool-call", { tool: String(event.data.name), label: String(event.data.name), args: (event.data.args ?? {}) as Record<string, unknown> } as never);
            } else if (event.type === "tool/result") {
              send("user-style:tool-call-done", { tool: String(event.data.name), ok: event.data.ok !== false } as never);
            }
          };
          const chatReq = { message: userPrompt, threadId: sessionId, workspaceId: req.workspaceId, projectId: req.projectId, config: { maxSteps: 6, temperature: 0.3, reasoningEffort: "off" as const } };
          try {
            await runEngineTapped({
              ctx: engineCtx, sessionId, prompt: userPrompt, cwd: ctx.workspacePath,
              projectId: req.projectId, workspaceId: req.workspaceId, systemPrompt,
              llmConfig: { baseUrl: cfg.baseUrl, model: cfg.model, apiKey: cfg.apiKey, provider: "openai", apiMode: cfg.apiMode, maxSteps: 6, temperature: 0.3, reasoningEffort: "off" } as never,
              chat: { req: chatReq as never, policy: "safe" },
              allowTools, usageSource: "writing-style", noHooks: true,
              signal: abortCtrl.signal, tap,
            });
          } finally {
            forgetEngineSession(sessionId);
            await getEngineHost(ctx).destroy(sessionId).catch(() => undefined);
          }
          return content;
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
          error: errMsg(err),
        });
      } finally {
        // Only delete the map entry if it still references THIS run's
        // controller — a newer generation started for the same sender (which
        // aborted this one and replaced the entry) must not be removed here.
        if (abortControllers.get(event.sender.id) === abortCtrl) {
          abortControllers.delete(event.sender.id);
        }
      }
    })();
  });

  registerIpcOn("user-style:abort", (event) => {
    abortControllers.get(event.sender.id)?.abort();
    // The aborted run's finally clears the entry only when it still owns it,
    // so a freshly-started generation's controller survives this abort.
  });
}
