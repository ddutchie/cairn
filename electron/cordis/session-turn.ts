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
  await agent.whenIdle();
  const firstSeq = agent.session.seq;
  const cancel = () => agent.cancel?.({ kind: "user" });

  if (signal?.aborted) cancel();
  else signal?.addEventListener("abort", cancel, { once: true });

  try {
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
    return { firstSeq, ...(completionResult.completed ? { completion: completionResult.value } : {}) };
  } finally {
    signal?.removeEventListener("abort", cancel);
  }
}
