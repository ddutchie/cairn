/**
 * Unit tests for session scoping in cairnQuestionsPlugin.
 *
 * The `user-questions/request` waterfall reaches every root listener, so each
 * mount must answer only requests whose asking agent belongs to its own
 * session and pass the rest down the chain — otherwise concurrent chat +
 * coding turns answer each other's questions. Fake ctx with chained
 * waterfall dispatch; scripted renderer answers; no live model.
 */
import { describe, it, expect } from "vitest";
import { cairnQuestionsPlugin } from "./cairn-plugins";

type Handler = (...args: unknown[]) => unknown;

interface Asked { sessionId: string; requestId: string }

function makeCtx() {
  const handlers = new Map<string, Handler[]>();
  const ctx = {
    userQuestions: {},
    on: (ev: string, fn: Handler) => {
      const list = handlers.get(ev) ?? [];
      list.push(fn);
      handlers.set(ev, list);
      return () => { handlers.set(ev, (handlers.get(ev) ?? []).filter((h) => h !== fn)); };
    },
  };
  // Dispatch like Cordis waterfall: first listener wins unless it calls next().
  const dispatch = (ev: string, request: unknown): unknown => {
    const list = [...(handlers.get(ev) ?? [])];
    const run = (index: number): unknown => {
      if (index >= list.length) return Promise.reject(new Error("NO_PROVIDER"));
      return list[index](request, () => run(index + 1));
    };
    return run(0);
  };
  return { ctx, dispatch };
}

function mountAnswerer(
  ctx: ReturnType<typeof makeCtx>["ctx"],
  sessionId: string,
  asked: Asked[],
  answerText: string,
) {
  const pending = new Map<string, (text: string) => void>();
  cairnQuestionsPlugin(ctx as never, {
    sessionId,
    send: () => {},
    emitQuestions: (requestId: string) => {
      asked.push({ sessionId, requestId });
    },
    registerPending: (requestId: string, resolve: (text: string) => void) => {
      pending.set(requestId, resolve);
      // Scripted renderer: answer on next tick.
      setTimeout(() => pending.get(requestId)?.(answerText), 0);
      return () => { pending.delete(requestId); };
    },
  });
}

const agentOf = (sessionId: string) => ({ id: sessionId, session: { id: sessionId } });

describe("cairnQuestionsPlugin session scoping", () => {
  it("routes concurrent sessions to their own renderer", async () => {
    const { ctx, dispatch } = makeCtx();
    const askedA: Asked[] = [];
    const askedB: Asked[] = [];
    // Distinct scripted answers prove which mount answered which request.
    mountAnswerer(ctx, "session-a", askedA, '{"answers":[{"id":"q1","selected":[],"custom":"from-a"}]}');
    mountAnswerer(ctx, "session-b", askedB, '{"answers":[{"id":"q1","selected":[],"custom":"from-b"}]}');

    const [ra, rb] = await Promise.all([
      dispatch("user-questions/request", {
        questions: [{ id: "q1", label: "L", prompt: "P" }],
        agent: agentOf("session-a"),
      }) as Promise<{ answers: Array<{ custom?: string }> }>,
      dispatch("user-questions/request", {
        questions: [{ id: "q1", label: "L", prompt: "P" }],
        agent: agentOf("session-b"),
      }) as Promise<{ answers: Array<{ custom?: string }> }>,
    ]);

    expect(askedA).toHaveLength(1);
    expect(askedB).toHaveLength(1);
    expect(ra.answers[0]?.custom).toBe("from-a");
    expect(rb.answers[0]?.custom).toBe("from-b");
  });

  it("falls through to NO_PROVIDER when no mount owns the asker", async () => {
    const { ctx, dispatch } = makeCtx();
    const asked: Asked[] = [];
    mountAnswerer(ctx, "session-a", asked, '{"answers":[]}');

    await expect(
      dispatch("user-questions/request", {
        questions: [{ id: "q1", label: "L", prompt: "P" }],
        agent: agentOf("session-other"),
      }),
    ).rejects.toThrow("NO_PROVIDER");
    expect(asked).toHaveLength(0);
  });

  it("answers unattributed asks (tool path without an agent)", async () => {
    const { ctx, dispatch } = makeCtx();
    const asked: Asked[] = [];
    mountAnswerer(ctx, "session-a", asked, '{"answers":[{"id":"q1","selected":[],"custom":"y"}]}');

    const result = (await dispatch("user-questions/request", {
      questions: [{ id: "q1", label: "L", prompt: "P" }],
    })) as { answers: Array<{ custom?: string }> };
    expect(asked).toHaveLength(1);
    expect(result.answers[0]?.custom).toBe("y");
  });
});
