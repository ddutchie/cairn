/**
 * runAgent retries transient provider failures (shared retry policy) but only while nothing has
 * streamed, never for non-transient errors, and stops when the caller aborts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ attempts: [] as (() => AsyncGenerator<unknown>)[], calls: 0 }));

vi.mock("./providers", () => ({
  resolveProvider: async () => ({
    stream: () => {
      const next = h.attempts[Math.min(h.calls++, h.attempts.length - 1)];
      return next();
    },
  }),
}));
vi.mock("./tools", () => ({ toolsForAgent: () => ({}), allToolMap: () => new Map() }));
vi.mock("./token-breakdown", () => ({ computeBreakdown: () => ({}), scaleBreakdown: (b: unknown) => b }));
vi.mock("./ai-config", () => ({ getChatPersonalityId: () => null, getChatMaxSteps: () => 5, getChatTemperature: () => undefined }));
vi.mock("./personalities-registry", () => ({ getCachedPersonalitiesManifest: () => null }));

const { runAgent, userMessage } = await import("./agent");

const fails = (message: string) => async function* () { throw new Error(message); };
const answers = (text: string) => async function* () {
  yield { type: "text-delta", delta: text };
  yield { type: "finish", finishReason: "stop" };
};
const failsAfterOutput = (message: string) => async function* () {
  yield { type: "text-delta", delta: "partial" };
  throw new Error(message);
};

const run = async (signal?: AbortSignal) => {
  const events: { type: string; [k: string]: unknown }[] = [];
  const promise = runAgent([userMessage("hi")], (e) => events.push(e as never), signal);
  await vi.runAllTimersAsync();
  return { text: await promise, events };
};

beforeEach(() => { h.calls = 0; h.attempts = []; vi.useFakeTimers(); });
afterEach(() => vi.useRealTimers());

describe("runAgent retries", () => {
  it("recovers from a transient failure and reports the retry", async () => {
    h.attempts = [fails("503 Service Unavailable"), fails("fetch failed"), answers("hello")];
    const { text, events } = await run();
    expect(text).toBe("hello");
    expect(h.calls).toBe(3);
    expect(events.filter((e) => e.type === "retry").map((e) => [e.attempt, e.text])).toEqual([[1, "503 Service Unavailable"], [2, "fetch failed"]]);
    expect(events.at(-1)?.type).toBe("final");
  });

  it("does not retry a deterministic failure", async () => {
    h.attempts = [fails("401 invalid api key")];
    const { text, events } = await run();
    expect(h.calls).toBe(1);
    expect(text).toContain("invalid api key");
    expect(events.some((e) => e.type === "retry")).toBe(false);
    expect(events.at(-1)?.type).toBe("error");
  });

  it("does not retry once output has streamed, so nothing is shown twice", async () => {
    h.attempts = [failsAfterOutput("connection lost"), answers("again")];
    const { events } = await run();
    expect(h.calls).toBe(1);
    expect(events.some((e) => e.type === "retry")).toBe(false);
    expect(events.at(-1)?.type).toBe("error");
  });

  it("gives up after the retry budget and shows the connection hint", async () => {
    h.attempts = [fails("fetch failed")];
    const { text, events } = await run();
    expect(h.calls).toBe(6); // first attempt + 5 retries
    expect(events.filter((e) => e.type === "retry")).toHaveLength(5);
    expect(text).toContain("needs a connection");
  });

  it("stops retrying when the caller aborts", async () => {
    const ac = new AbortController();
    h.attempts = [fails("503 Service Unavailable")];
    const promise = runAgent([userMessage("hi")], undefined, ac.signal);
    await vi.advanceTimersByTimeAsync(0);
    ac.abort();
    await vi.runAllTimersAsync();
    await promise;
    expect(h.calls).toBe(1);
  });
});
