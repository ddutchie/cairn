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
    return { firstSeq, ...(completionResult.completed ? { completion: completionResult.value } : {}) };
  } finally {
    signal?.removeEventListener("abort", cancel);
  }
}
