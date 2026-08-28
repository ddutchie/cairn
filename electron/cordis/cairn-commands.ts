/**
 * cairn-commands — shared compaction helper.
 *
 * The human-facing `/compact` command is now provided by
 * `@deepseek-ai/dsh-command-compact` (mounted in cordis-context). This module
 * retains only the session-as-truth helper `compactChatSession`, which backs
 * the `chat:compactThread` IPC — the underlying `ctx.compaction.compactNow`
 * seam is the same, but the IPC path needs the explicit
 * `ensureAgentAiAdapter` + `resumeChatAgent` dance that the dsh command (which
 * compacts `invocation.agent` as-is) does not.
 */
import type { Context } from "@deepseek-ai/cordis";
import { ManualCompactionError } from "@deepseek-ai/dsh-compaction";
import "./ctx-augment";

/**
 * Concise human messages for the expected `ManualCompactionError` codes —
 * mirrors dsh-command-compact's `expectedFailure` so the user gets the same
 * classified guidance (especially the `commit` "inspect before retrying" and
 * `persistence` "couldn't be saved" warnings) instead of a raw error string.
 */
function manualCompactionMessage(code: ManualCompactionError["code"]): string {
  switch (code) {
    case "busy": return "Compaction is unavailable — this process already has an active compaction, or the agent is not idle.";
    case "cancelled": return "Compaction cancelled.";
    case "changed": return "The history selected for compaction changed before it could be replaced. The conversation is unchanged; the attempt is recorded in the session log.";
    case "summary": return "Compaction could not produce a useful summary. The conversation is unchanged; the attempt is recorded in the session log.";
    case "commit": return "Compaction did not finish cleanly; some session history may have changed. Inspect the current session state before retrying.";
    case "persistence": return "Compaction finished, but the session could not be saved.";
    default: return "Compaction failed.";
  }
}

/** Shared compaction flow: resume the thread's agent + run compactNow. */
export async function compactChatSession(
  getContext: () => Promise<Context>,
  threadId: string,
  model: { baseUrl?: string; model?: string; apiKey?: string; apiMode?: "responses" | "completions" | "anthropic-messages" } = {},
): Promise<{ ok: boolean; compacted: boolean; error?: string; summaryText?: string }> {
  try {
    const { ensureAgentAiAdapter, resumeChatAgent } = await import("./run-cordis-loop");
    const ctx = await getContext();
    const baseUrl = model.baseUrl ?? "";
    const apiKey = model.apiKey ?? "";
    const modelName = model.model ?? "";
    // Mount the pi-ai route for the summariser call on the SAME protocol the
    // live turns use — pinned from the saved provider's apiMode, never
    // auto-probed. Probing (resolveTransport) could mount a different `api`
    // than the session was written under and corrupt replay, and it can never
    // select anthropic-messages. completions is the default.
    const api = model.apiMode === "responses" ? "openai-responses"
      : model.apiMode === "anthropic-messages" ? "anthropic-messages"
      : "openai-completions";
    await ensureAgentAiAdapter(ctx, { baseUrl, model: modelName, apiKey, api });

    // NOTE: the third arg here is the resumed session's workspacePath (used
    // for CreateAgentOptions.meta.cwd on a fresh session, and IGNORED for a
    // pure resume). `ctx.root?.cwd` was a speculative reach — Cordis's
    // Context doesn't declare a cwd. process.cwd() is a safe fallback for
    // the create-agent path; resume is unaffected.
    const agent = await resumeChatAgent(threadId, process.cwd(), modelName);
    if (!agent) return { ok: false, compacted: false, error: "no session to compact (start a conversation first)" };

    const compaction = ctx.compaction;
    if (!compaction) return { ok: false, compacted: false, error: "compaction engine not available" };

    try {
      const result = await compaction.compactNow(agent as never, new AbortController().signal);
      if (result === null) return { ok: true, compacted: false };
      const r = result as { shadowedSeqs?: unknown[]; shadowedTokenCount?: number };
      const count = r.shadowedSeqs?.length ?? 0;
      const summaryText = count > 0
        ? `Compacted ${count} history item${count === 1 ? "" : "s"}${typeof r.shadowedTokenCount === "number" ? ` (~${r.shadowedTokenCount} tokens)` : ""}.`
        : "Conversation history compacted.";
      return { ok: true, compacted: true, summaryText };
    } catch (err) {
      // Expected capability failures carry a classified code → human message.
      if (err instanceof ManualCompactionError) {
        return { ok: false, compacted: false, error: manualCompactionMessage(err.code) };
      }
      throw err;
    }
  } catch (err) {
    return { ok: false, compacted: false, error: err instanceof Error ? err.message : String(err) };
  }
}


