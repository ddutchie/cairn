/**
 * Unit tests for session-durability flush bookkeeping — flush failures must
 * never throw to the caller (best-effort contract) but must leave a trace
 * via getSessionPersistenceHealth() instead of vanishing silently (the
 * "chats work in-session but nothing is ever written to disk" signature).
 */
import { describe, it, expect } from "vitest";
import { flushSession, getSessionPersistenceHealth } from "./session-durability";

function fakeCtx(flush: (s: unknown) => Promise<boolean>) {
  return { sessions: { flush } } as never;
}

describe("flushSession", () => {
  it("never throws when the backend flush rejects, and records the failure", async () => {
    const before = getSessionPersistenceHealth().consecutiveFlushFailures;
    await expect(
      flushSession(fakeCtx(async () => { throw new Error("EACCES: win32 publish"); }), { id: "s1" }),
    ).resolves.toBeUndefined();
    const health = getSessionPersistenceHealth();
    expect(health.consecutiveFlushFailures).toBe(before + 1);
    expect(health.lastFlushError).toContain("EACCES");
    expect(health.lastFlushErrorAt).not.toBeNull();
  });

  it("resets the streak on success", async () => {
    await flushSession(fakeCtx(async () => { throw new Error("boom"); }), { id: "s1" });
    const mid = getSessionPersistenceHealth().consecutiveFlushFailures;
    expect(mid).toBeGreaterThan(0);
    await flushSession(fakeCtx(async () => true), { id: "s1" });
    expect(getSessionPersistenceHealth().consecutiveFlushFailures).toBe(0);
  });

  it("is a no-op for missing sessions or absent flush backends", async () => {
    await expect(flushSession({} as never, null)).resolves.toBeUndefined();
    await expect(flushSession({} as never, undefined)).resolves.toBeUndefined();
    await expect(flushSession({} as never, { id: "s1" })).resolves.toBeUndefined();
  });
});
