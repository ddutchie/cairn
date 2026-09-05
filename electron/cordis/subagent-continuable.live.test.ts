import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";

import { applySchema } from "../db/schema";
import { runCordisLoop } from "./run-cordis-loop";
import {
  listSubagentChildren,
  messageSubagentChild,
  interruptSubagentChild,
} from "./subagent-control";

const BASE = process.env.CORDIS_TEST_BASE_URL ?? "http://localhost:3042/v1";
const MODEL = process.env.CORDIS_TEST_MODEL ?? "claude-sonnet-4-5";

function makeDb() {
  const db = new Database(":memory:");
  applySchema(db);
  const now = new Date().toISOString();
  db.prepare("INSERT INTO workspaces (id, name, created_at, updated_at) VALUES ('ws', 'W', ?, ?)").run(now, now);
  db.prepare("INSERT INTO projects (id, workspace_id, name, created_at, updated_at) VALUES ('pj', 'ws', 'P', ?, ?)").run(now, now);
  return db;
}

// Live proof of continuable delegation on the shared tree: the model starts a
// durable child with `delegate`, the host catalog lists it, a human message is
// accepted for it while the retained chat parent is live, and interrupt is
// accepted. Gated on CORDIS_LIVE=1.
describe.skipIf(process.env.CORDIS_LIVE !== "1")("continuable subagents (gated on CORDIS_LIVE=1; SKIPPED by default)", () => {
  it("delegate starts a durable child; host can message and interrupt it", async () => {
    const db = makeDb();
    const threadId = `thr-cont-${Date.now()}`;
    const parentSessionId = `chat-${threadId}`;

    const r1 = await runCordisLoop({
      db,
      req: {
        threadId, projectId: "pj", workspaceId: "ws",
        message: "You MUST call the delegate tool once with description 'count words' and prompt 'Reply with the single word apple and nothing else. Do not call any tools.'. Then reply briefly.",
        history: [],
      } as never,
      workspacePath: "/tmp",
      llmConfig: { baseUrl: BASE, model: MODEL, apiKey: "", provider: "openai" },
      signal: undefined,
    });
    expect(r1.content.length).toBeGreaterThan(0);

    // Durable catalog lists the fresh child as continuable (discovery through
    // the catalog itself — no model cooperation needed for the id).
    const catalog = await listSubagentChildren(parentSessionId);
    console.log("CATALOG:", JSON.stringify(catalog.entries));
    const rows = catalog.entries.filter((e) => !("kind" in e) && (e as { mode?: string }).mode === "continuable");
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const childId = (rows[0] as { id: string }).id;

    // Host message delivery while the retained chat parent is live.
    const sent = await messageSubagentChild(parentSessionId, childId, "Reply with the single word banana.");
    expect(typeof sent.messageId).toBe("string");

    // Interrupt is accepted (fire-and-return; absent targets are a no-op).
    await expect(interruptSubagentChild(parentSessionId, childId)).resolves.toEqual({ accepted: true });

    db.close();
  }, 180000);
});
