/**
 * Unit tests for dropChatAgentForThread — the clear-thread lifecycle hook that
 * evicts the module-global live chat agent so a cleared thread starts a FRESH
 * session on its next message (no stale-context reuse, no writes to deleted
 * session files).
 */
import { describe, it, expect } from "vitest";
import { dropChatAgentForThread } from "./run-cordis-loop";

interface FakeAgent {
  whenIdle?: () => Promise<void>;
  followup?: (msg: unknown) => void;
  session?: { seq: number; events: readonly unknown[] };
}

function seedMap(entry?: [string, Record<string, unknown>]): Map<string, Record<string, unknown>> {
  const map = new Map<string, Record<string, unknown>>();
  if (entry) map.set(entry[0], entry[1]);
  (globalThis as unknown as { __cairnChatAgents?: Map<string, Record<string, unknown>> }).__cairnChatAgents = map;
  return map;
}

describe("dropChatAgentForThread", () => {
  it("removes the cached agent and disposes it (after settling whenIdle)", async () => {
    const calls: string[] = [];
    const agent: FakeAgent & Record<string, unknown> = {
      whenIdle: async () => { calls.push("whenIdle"); },
      dispose: () => { calls.push("dispose"); },
      followup: () => {},
      session: { seq: 1, events: [] },
    };
    const map = seedMap(["thr-a", agent]);
    await dropChatAgentForThread("thr-a");
    expect(map.has("thr-a")).toBe(false);
    expect(calls).toEqual(["whenIdle", "dispose"]);
  });

  it("is a no-op when the map is absent or the thread has no cached agent", async () => {
    seedMap();
    await expect(dropChatAgentForThread("thr-none")).resolves.toBeUndefined();
    delete (globalThis as unknown as { __cairnChatAgents?: unknown }).__cairnChatAgents;
    await expect(dropChatAgentForThread("thr-none")).resolves.toBeUndefined();
  });

  it("survives a throwing whenIdle/dispose (best-effort teardown)", async () => {
    const map = seedMap(["thr-b", {
      whenIdle: async () => { throw new Error("aborted"); },
      dispose: () => { throw new Error("boom"); },
    }]);
    await expect(dropChatAgentForThread("thr-b")).resolves.toBeUndefined();
    expect(map.has("thr-b")).toBe(false);
  });

  it("disposes via Symbol.asyncDispose when no plain .dispose exists (dsh agent handles)", async () => {
    const calls: string[] = [];
    const agent = {
      whenIdle: async () => { calls.push("whenIdle"); },
      // dsh agent-loop disposes via Symbol.asyncDispose; plain .dispose absent.
      [Symbol.asyncDispose]: async () => { calls.push("asyncDispose"); },
    };
    const map = seedMap(["thr-d", agent as unknown as Record<string, unknown>]);
    await dropChatAgentForThread("thr-d");
    expect(map.has("thr-d")).toBe(false);
    expect(calls).toEqual(["whenIdle", "asyncDispose"]);
  });
});
