import { createUserMessage } from "@deepseek-ai/dsh-llm";

export interface CordisTurnAgent {
  followup: (message: unknown) => unknown;
  whenIdle: () => Promise<unknown>;
  session: { seq: number };
  cancel?: (cause: { kind: "user" }) => void;
}

export interface RunCordisTurnOptions {
  agent: CordisTurnAgent;
  content: unknown;
  signal?: AbortSignal;
  completion?: Promise<unknown>;
}

/** Run one user turn with the same cancellation and idle semantics everywhere. */
export async function runCordisTurn({ agent, content, signal, completion }: RunCordisTurnOptions): Promise<{ firstSeq: number; completion?: unknown }> {
  const timing = process.env.CAIRN_TIMING === "1" || process.env.CAIRN_TIMING === "true";
  const t0 = timing ? Date.now() : 0;
  await agent.whenIdle();
  if (timing) console.log(`[timing]   runCordisTurn: pre-followup whenIdle (waiting on PREVIOUS turn to settle) ${Date.now() - t0}ms`);
  // Opportunistic pruning before the model turn lowers pressure before the
  // 0.8 threshold check (the compaction engine also prunes before its own
  // threshold, but an early prune can avoid summarization entirely). Guarded
  // against mid-compaction via compaction/start|end bridging in prune-hook.
  try {
    const { tryPruneSession } = await import("./prune-hook");
    await tryPruneSession(agent as never);
  } catch { /* pruning is best-effort */ }
  const firstSeq = agent.session.seq;
  const cancel = () => agent.cancel?.({ kind: "user" });

  if (signal?.aborted) cancel();
  else signal?.addEventListener("abort", cancel, { once: true });

  try {
    const t1 = timing ? Date.now() : 0;
    agent.followup(createUserMessage({
      content: content as never,
      source: { kind: "user" },
    }));
    const idle = agent.whenIdle();
    const completionResult = completion
      ? await Promise.race([
        completion.then((value) => ({ completed: true, value })),
        idle.then(() => ({ completed: false, value: undefined })),
      ])
      : { completed: false, value: await idle };
    if (timing) console.log(`[timing]   runCordisTurn: followup → turn idle (the model turn itself) ${Date.now() - t1}ms`);
    // Idle hook: once per idle transition, after the turn's idle, attempt
    // pruning (it lowers pressure for the NEXT turn's 0.8 check). Guarded
    // against mid-compaction; best-effort so a prune failure never breaks
    // the turn.
    try {
      const { tryPruneSession } = await import("./prune-hook");
      await tryPruneSession(agent as never);
    } catch { /* best-effort */ }
    // Post-turn durability: flush the buffered JSONL prefix now that the turn
    // is idle. Retained chat agents skip the disposal drain between turns and
    // otherwise rely solely on the backend's 200ms write-behind timer, so a
    // crash in that window would lose the final tool/result + turn/end batch.
    // Best-effort — never throws at the turn boundary.
    try {
      const { flushSession } = await import("./plugins/session-durability");
      const { getContext } = await import("./cordis-context");
      const c = await getContext();
      const sess = (agent as unknown as { session?: unknown }).session;
      if (sess) await flushSession(c as never, sess);
    } catch { /* best-effort flush */ }
    return { firstSeq, ...(completionResult.completed ? { completion: completionResult.value } : {}) };
  } finally {
    signal?.removeEventListener("abort", cancel);
  }
}
