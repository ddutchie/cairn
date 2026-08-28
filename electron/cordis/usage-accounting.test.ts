import { describe, expect, it, beforeEach } from "vitest";
import BetterSqlite3 from "better-sqlite3";
import type Database from "better-sqlite3";
import { applySchema } from "../db/schema";
import { initUsageRecorder } from "../lib/usage-recorder";
import { cairnUsagePlugin } from "./cairn-plugins";
import type { Session, SessionEvent } from "@deepseek-ai/dsh-session";

/**
 * Regression suite for `llm_usage` accounting.
 *
 * The plugin used to accumulate (`prompt = max(...)`, `completion += ...`) and
 * write a row on EVERY usage event, so a 4-step turn produced four rows of
 * running totals. `queryUsageOverview` SUMs rows, so a single turn's prompt
 * tokens were counted ~4x and its cost inflated to match. On top of that,
 * `ipc/chat.ts` and `lib/heartbeat-runner.ts` each wrote their own row, and the
 * source was hardcoded to "chat" for every profile.
 *
 * Observed on real data before the fix: one turn recorded 59,186 prompt tokens
 * and $0.272 against a true 13,623 / $0.069.
 */

type Handler = (session: Session, event: SessionEvent) => void;

function harness() {
  let handler: Handler | null = null;
  const ctx = { on: (_ev: string, fn: Handler) => { handler = fn; return () => { handler = null; }; } };
  const fire = (event: SessionEvent, origin?: "subagent") =>
    handler?.({ id: origin ? "child-1" : "s1", header: origin ? { origin, parentSession: "s1" } : {} } as unknown as Session, event);
  return { ctx, fire };
}

function usageChunk(inputTokens: number, outputTokens: number, reasoningTokens = 0): SessionEvent {
  return {
    type: "assistant/chunk",
    seq: 1,
    time: Date.now(),
    data: { chunk: { type: "usage", usage: { inputTokens, outputTokens, reasoningTokens } } },
  } as unknown as SessionEvent;
}

let db: Database.Database;

function rows() {
  return db.prepare("SELECT source, prompt_tokens, completion_tokens FROM llm_usage ORDER BY rowid").all() as Array<{ source: string; prompt_tokens: number; completion_tokens: number }>;
}

describe("cairnUsagePlugin — one row per request", () => {
  beforeEach(() => {
    db = new BetterSqlite3(":memory:");
    applySchema(db);
    initUsageRecorder(db);
  });

  it("records each request's OWN tokens, never a running total", () => {
    const { ctx, fire } = harness();
    cairnUsagePlugin(ctx as never, { threadId: "s1", workspaceId: "w1", model: "test-model", source: "chat" });

    // The four steps of a real turn, as the provider reported them.
    fire(usageChunk(8802, 151));
    fire(usageChunk(11183, 67));
    fire(usageChunk(11955, 135));
    fire(usageChunk(13623, 625));

    expect(rows().map((r) => [r.prompt_tokens, r.completion_tokens])).toEqual([
      [8802, 151], [11183, 67], [11955, 135], [13623, 625],
    ]);
    // Pre-fix this summed to 2678 completion tokens instead of 978.
    const summed = rows().reduce((acc, r) => acc + r.completion_tokens, 0);
    expect(summed).toBe(978);
  });

  it("skips usage events that carry no counts", () => {
    const { ctx, fire } = harness();
    cairnUsagePlugin(ctx as never, { threadId: "s1", workspaceId: "w1", model: "test-model", source: "chat" });

    fire(usageChunk(0, 0));
    fire(usageChunk(0, 0, 0));
    expect(rows()).toHaveLength(0);

    fire(usageChunk(10, 5));
    expect(rows()).toHaveLength(1);
  });

  it("attributes rows to the configured source, not a hardcoded 'chat'", () => {
    const { ctx, fire } = harness();
    cairnUsagePlugin(ctx as never, { threadId: "s1", workspaceId: "w1", model: "test-model", source: "coding-agent" });

    fire(usageChunk(100, 10));
    expect(rows()[0].source).toBe("coding-agent");
  });

  it("re-tags subagent child sessions onto the *-subagent source", () => {
    const { ctx, fire } = harness();
    cairnUsagePlugin(ctx as never, { threadId: "s1", workspaceId: "w1", model: "test-model", source: "coding-agent" });

    fire(usageChunk(100, 10));                 // parent
    fire(usageChunk(50, 5), "subagent");       // child

    expect(rows().map((r) => r.source)).toEqual(["coding-agent", "coding-subagent"]);
  });

  it("maps a chat parent's children to chat-subagent", () => {
    const { ctx, fire } = harness();
    cairnUsagePlugin(ctx as never, { threadId: "s1", workspaceId: "w1", model: "test-model", source: "chat" });

    fire(usageChunk(50, 5), "subagent");
    expect(rows()[0].source).toBe("chat-subagent");
  });

  it("falls back to assistant/message usage only when the step reported none", () => {
    const { ctx, fire } = harness();
    cairnUsagePlugin(ctx as never, { threadId: "s1", workspaceId: "w1", model: "test-model", source: "chat" });

    const message = (inputTokens: number, outputTokens: number): SessionEvent => ({
      type: "assistant/message",
      seq: 2,
      time: Date.now(),
      data: { usage: { inputTokens, outputTokens } },
    } as unknown as SessionEvent);

    // Chunk already reported → the message must not double-record.
    fire(usageChunk(100, 10));
    fire(message(100, 10));
    expect(rows()).toHaveLength(1);

    // Next step reports nothing on the chunk → the message is the only source.
    fire(message(200, 20));
    expect(rows()).toHaveLength(2);
    expect(rows()[1]).toMatchObject({ prompt_tokens: 200, completion_tokens: 20 });
  });
});
