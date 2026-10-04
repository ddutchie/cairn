import type { Context } from "@deepseek-ai/cordis";
import "../ctx-augment";

// ── cairn-system-prompt ───────────────────────────────────────────────────────
export interface CairnSystemPromptConfig {
  /**
   * The fully-assembled Cairn system prompt for this turn: identity + tool
   * rules + date (buildSystemPrompt), personality layered on (withPersonality),
   * and any prior conversation folded in as a transcript. Registered as the
   * first prompt section the model reads.
   */
  systemText: string;
}

/**
 * Registers Cairn's per-turn system prompt as an ordered prompt section on the
 * Cordis tree, mirroring how dsh's own capability plugins (tool-fs, tool-web,
 * …) contribute prompt guidance via `ctx.systemPrompt.section()`. Mounted per
 * call (the prompt is per-request: date, personality, project context,
 * history), so it's disposed with the turn's fiber like the other cairn-*
 * plugins — no inline `setup()` wiring in the loop.
 *
 * The section name is distinct from dsh's reserved `deployment:persona` (which
 * the system-prompt plugin owns and we leave empty), and its low order places
 * Cairn's identity first. dsh suppresses its own harness identity
 * (includeHarnessIdentity:false), so this is the only identity the model sees.
 */
let activeSystemText = "";

export function updateSystemPrompt(text: string): void {
  activeSystemText = text;
}

export function cairnSystemPromptPlugin(ctx: Context, config: CairnSystemPromptConfig): (() => void) | void {
  const { systemText } = config;
  if (systemText) activeSystemText = systemText;

  const sp = ctx.systemPrompt;
  if (!sp || typeof sp.section !== "function") return;

  // Capture the per-turn value directly — the old `() => activeSystemText`
  // shared a process-global mutable that raced when chat + coding turns
  // mounted the plugin concurrently on the singleton context (P0-3).
  const captured = systemText ?? activeSystemText;
  return sp.section({
    name: "cairn:system",
    order: -100,
    text: captured,
  });
}
cairnSystemPromptPlugin.inject = ["systemPrompt"];
