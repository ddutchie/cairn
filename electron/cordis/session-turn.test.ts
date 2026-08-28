import { describe, expect, it, vi } from "vitest";
import { runCordisTurn, type CordisTurnAgent } from "./session-turn";

function agent(overrides: Partial<CordisTurnAgent> = {}): CordisTurnAgent {
  return {
    followup: vi.fn(),
    whenIdle: vi.fn().mockResolvedValue(undefined),
    session: { seq: 7 },
    ...overrides,
  };
}

describe("runCordisTurn", () => {
  it("waits for idle, follows up once, and returns the starting sequence", async () => {
    const a = agent();

    const result = await runCordisTurn({ agent: a, content: "hello" });

    expect(a.whenIdle).toHaveBeenCalledTimes(2);
    expect(a.followup).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ firstSeq: 7 });
    expect((a.followup as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toMatchObject({
      source: { kind: "user" },
    });
  });

  it("cancels the agent when the signal is already aborted", async () => {
    const cancel = vi.fn();
    const a = agent({ cancel });
    const controller = new AbortController();
    controller.abort();

    await runCordisTurn({ agent: a, content: "stop", signal: controller.signal });

    expect(cancel).toHaveBeenCalledWith({ kind: "user" });
  });

  it("preserves an explicit completion result when it wins over idle", async () => {
    let idleCalls = 0;
    const a = agent({
      whenIdle: vi.fn().mockImplementation(() => {
        idleCalls += 1;
        return idleCalls === 1 ? Promise.resolve() : new Promise(() => {});
      }),
    });
    const completion = Promise.resolve({ ok: false, error: "agent error" });

    await expect(runCordisTurn({ agent: a, content: "run", completion })).resolves.toMatchObject({
      firstSeq: 7,
      completion: { ok: false, error: "agent error" },
    });
  });
});
