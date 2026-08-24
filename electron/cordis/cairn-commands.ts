/**
 * cairn-commands — registers Cairn's executable commands into the dsh command
 * runtime (ctx.commands) so they share one namespace with plugin commands
 * (/plan, /permission, …) and are executed through the same logged path.
 *
 * Today: `compact` — session-as-truth compaction via ctx.compaction.compactNow
 * on the thread's resumed agent (the same flow the chat:compactThread IPC uses;
 * both delegate to compactChatSession below so there is exactly one
 * implementation).
 */
import type { Context } from "@deepseek-ai/cordis";
import "./ctx-augment";

/** Shared compaction flow: resume the thread's agent + run compactNow. */
export async function compactChatSession(
  getContext: () => Promise<Context>,
  threadId: string,
  model: { baseUrl?: string; model?: string; apiKey?: string } = {},
): Promise<{ ok: boolean; compacted: boolean; error?: string }> {
  try {
    const { ensureAgentAiAdapter, resumeChatAgent } = await import("./run-cordis-loop");
    const { resolveTransport } = await import("../lib/llm-transport");
    const ctx = await getContext();
    const baseUrl = model.baseUrl ?? "";
    const apiKey = model.apiKey ?? "";
    const modelName = model.model ?? "";
    // Ensure the pi-ai route is mounted for the summariser model call.
    const transport = await resolveTransport(baseUrl, apiKey);
    await ensureAgentAiAdapter(ctx, { baseUrl, model: modelName, apiKey, api: transport.mode === "responses" ? "openai-responses" : "openai-completions" });

    // NOTE: the third arg here is the resumed session's workspacePath (used
    // for CreateAgentOptions.meta.cwd on a fresh session, and IGNORED for a
    // pure resume). `ctx.root?.cwd` was a speculative reach — Cordis's
    // Context doesn't declare a cwd. process.cwd() is a safe fallback for
    // the create-agent path; resume is unaffected.
    const agent = await resumeChatAgent(threadId, process.cwd(), modelName);
    if (!agent) return { ok: false, compacted: false, error: "no session to compact (start a conversation first)" };

    const compaction = ctx.compaction;
    if (!compaction) return { ok: false, compacted: false, error: "compaction engine not available" };

    const result = await compaction.compactNow(agent as never, new AbortController().signal);
    return { ok: true, compacted: result !== null };
  } catch (err) {
    return { ok: false, compacted: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Register Cairn's commands on the dsh command runtime (best-effort). */
export function registerCairnCommands(ctx: Context): void {
  const commands = ctx.commands;
  if (!commands || typeof commands.register !== "function") return;
  try {
    commands.register({
      name: "compact",
      description: "Summarise and compact this conversation's history",
      recordInput: false,
      async handler({ agent }: { agent: unknown }) {
        // The executing agent IS the thread's resumed chat agent
        // (sessionId chat-<threadId>) — compact it directly.
        const sessionId = String((agent as { session?: { id?: unknown } }).session?.id ?? "");
        const threadId = sessionId.startsWith("chat-") ? sessionId.slice(5) : sessionId;
        const { getCachedConfig } = await import("../lib/config-cache");
        const cfg = getCachedConfig().agentConfig ?? {};
        const res = await compactChatSession(() => Promise.resolve(ctx), threadId, { baseUrl: cfg.baseUrl, model: cfg.model, apiKey: cfg.apiKey });
        if (!res.ok && res.error) return { kind: "error", text: `compact failed: ${res.error}` };
        return { kind: "success", text: res.compacted ? "Conversation history compacted." : "Nothing to compact yet." };
      },
    });
  } catch (err) {
    console.warn("[cairn-commands] failed to register compact:", err instanceof Error ? err.message : err);
  }
}
