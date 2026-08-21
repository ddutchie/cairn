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

/** Shared compaction flow: resume the thread's agent + run compactNow. */
export async function compactChatSession(
  getContext: () => Promise<Context>,
  threadId: string,
  model: { baseUrl?: string; model?: string; apiKey?: string } = {},
): Promise<{ ok: boolean; compacted: boolean; error?: string }> {
  try {
    const { ensurePiAiAdapter, resumeChatAgent } = await import("./run-cordis-loop");
    const { resolveTransport } = await import("../lib/llm-transport");
    const ctx = await getContext();
    const baseUrl = model.baseUrl ?? "";
    const apiKey = model.apiKey ?? "";
    const modelName = model.model ?? "";
    // Ensure the pi-ai route is mounted for the summariser model call.
    const transport = await resolveTransport(baseUrl, apiKey);
    await ensurePiAiAdapter(ctx, { baseUrl, model: modelName, apiKey, api: transport.mode === "responses" ? "openai-responses" : "openai-completions" });

    const agent = await resumeChatAgent(threadId, (ctx as unknown as { root?: { cwd?: string } }).root?.cwd ?? process.cwd(), modelName);
    if (!agent) return { ok: false, compacted: false, error: "no session to compact (start a conversation first)" };

    const compaction = (ctx as unknown as { compaction?: { compactNow: (a: unknown, signal: AbortSignal, cmd?: unknown) => Promise<{ summary?: unknown } | null> } }).compaction;
    if (!compaction) return { ok: false, compacted: false, error: "compaction engine not available" };

    const result = await compaction.compactNow(agent, new AbortController().signal);
    return { ok: true, compacted: result !== null };
  } catch (err) {
    return { ok: false, compacted: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Register Cairn's commands on the dsh command runtime (best-effort). */
export function registerCairnCommands(ctx: Context): void {
  const commands = (ctx as unknown as { commands?: { register: (def: unknown) => unknown } }).commands;
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
