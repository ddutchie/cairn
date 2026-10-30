import { describe, expect, it } from "vitest";
import BetterSqlite3 from "better-sqlite3";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { applySchema } from "../db/schema";
import { openSession } from "./session/log";
import { exchangesOf, indexSessions, searchSessionsSemantic, type EmbedFn } from "./session-search";
import { sessionTools } from "./tools/sessions";

/** Deterministic stand-in for the model: hashed bag of words, normalised. Same words => similar. */
const embed: EmbedFn = async (texts) => texts.map((t) => {
  const v = new Array(64).fill(0);
  for (const w of t.toLowerCase().match(/[a-z]+/g) ?? []) { let h = 0; for (const c of w) h = (h * 31 + c.charCodeAt(0)) % 64; v[h] += 1; }
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / n);
});

async function seed(root: string, id: string, pairs: Array<[string, string]>) {
  const { writer } = await openSession(root, { id, cwd: "/w" });
  for (const [q, a] of pairs) {
    await writer.append({ type: "user/message", content: q });
    await writer.append({ type: "assistant/message", message: { role: "assistant", content: [{ type: "text", text: a }] } as never });
  }
}

describe("semantic session search", () => {
  it("indexes incrementally, ranks by similarity, scopes to the workspace and drops deleted sessions", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sem-"));
    const db = new BetterSqlite3(":memory:");
    applySchema(db);
    let calls = 0;
    const counting: EmbedFn = async (t, task, m) => { calls += t.length; return embed(t, task, m); };
    const d = { db, root, workspaceId: "ws", model: "m", embed: counting };
    try {
      await seed(root, "chat-a", [["How should the nightly export job report failures", "Send a Slack message on failure"], ["Pick a colour palette", "Use the sage palette"]]);
      await seed(root, "chat-b", [["Unrelated gardening question about tomatoes", "Water them daily"]]);
      await seed(root, "chat-x", [["nightly export job failures slack", "other workspace"]]);
      const allowed = new Set(["chat-a", "chat-b"]);

      const first = await searchSessionsSemantic(d, allowed, "nightly export job failures", 5);
      expect(first.hits[0]).toMatchObject({ sessionId: "chat-a", idx: 0 });
      expect(first.hits.map((h) => h.sessionId)).not.toContain("chat-x");
      expect(first.hits.map((h) => h.sessionId)).not.toContain("chat-b");

      const embedded = calls;
      await indexSessions(d, ["chat-a", "chat-b"]);
      expect(calls).toBe(embedded); // nothing changed, nothing re-embedded

      await seed(root, "chat-a", [["Another question about export retries", "Retry three times"]]);
      const { embedded: n } = await indexSessions(d, ["chat-a"]);
      expect(n).toBe(1); // only the new exchange

      await rm(path.join(root, "chat-a"), { recursive: true });
      await searchSessionsSemantic(d, allowed, "export", 5);
      expect(db.prepare("SELECT COUNT(*) AS n FROM session_embeddings WHERE session_id = 'chat-a'").get()).toEqual({ n: 0 });
    } finally {
      db.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("the tool lists meaning matches first and still works without embeddings", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sem-"));
    const db = new BetterSqlite3(":memory:");
    applySchema(db);
    try {
      await seed(root, "chat-a", [["How should the nightly export job report failures", "Send a Slack message on failure"]]);
      const base = { root, currentSession: "chat-now", workspaceSessionIds: () => new Set(["chat-a"]) };
      const [withSem] = sessionTools({ ...base, semantic: (q, l) => searchSessionsSemantic({ db, root, workspaceId: "ws", model: "m", embed }, new Set(["chat-a"]), q, l) });
      const out = await withSem.execute({ query: "nightly export job failures" }, {} as never);
      expect(out.content).toMatch(/chat-a.*similarity/);
      const [plain] = sessionTools({ ...base, semantic: async () => null });
      expect((await plain.execute({ query: "slack" }, {} as never)).content).toContain("chat-a");
    } finally {
      db.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("exchangesOf groups a user message with its replies", () => {
    const rec = (seq: number, event: never) => ({ seq, time: seq, event });
    const ex = exchangesOf([
      rec(0, { type: "user/message", content: "q1" } as never),
      rec(1, { type: "assistant/message", message: { role: "assistant", content: [{ type: "text", text: "a1" }] } } as never),
      rec(2, { type: "user/message", content: "q2" } as never),
    ]);
    expect(ex.map((e) => e.idx)).toEqual([0, 2]);
    expect(ex[0].text).toContain("a1");
  });
});
