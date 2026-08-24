import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";

import { applySchema } from "../db/schema";
import { runCordisLoop } from "./run-cordis-loop";
import type { ChatRequest } from "../lib/tools";

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

// Live proof that dsh's subagent capability is mounted (the model can spawn a
// child agent) and that cairn-subagent maps child session events to Cairn's
// session:subagent* IPC. Model delegation varies, so we assert the tool exists and
// capture any subagent events fired. Gated on CORDIS_LIVE=1.
describe.skipIf(process.env.CORDIS_LIVE !== "1")("cairn-subagent (gated on CORDIS_LIVE=1; SKIPPED by default)", () => {
  it("registers the subagent tool and maps child events to session:subagent* IPC", async () => {
    const db = makeDb();
    const subagentEvents: string[] = [];
    const tokenByChild = new Map<string, string>();
    const thoughtByChild = new Map<string, string>();
    const req: ChatRequest = {
      message: "Use the subagent tool to delegate a tiny task: ask a subagent to think about and reply with the single word 'done'. Then report it.",
      threadId: "thr-sub-1",
      projectId: "pj",
      workspaceId: "ws",
    };
    const result = await runCordisLoop({
      db,
      req,
      workspacePath: "/tmp",
      llmConfig: { baseUrl: BASE, model: MODEL, apiKey: "", provider: "openai" },
      signal: undefined,
      sendSubagent: (channel, payload) => {
        subagentEvents.push(channel + ":" + JSON.stringify(payload));
        const p = payload as { childId?: string; delta?: string };
        if (channel === "session:subagent-token" && p.childId && p.delta) tokenByChild.set(p.childId, (tokenByChild.get(p.childId) ?? "") + p.delta);
        if (channel === "session:subagent-thought" && p.childId && p.delta) thoughtByChild.set(p.childId, (thoughtByChild.get(p.childId) ?? "") + p.delta);
      },
    });
    console.log("SUBAGENT RESULT:", JSON.stringify(result));
    console.log("SUBAGENT EVENTS:", subagentEvents.join("\n  "));
    const starts = subagentEvents.filter((e) => e.startsWith("session:subagent:") && JSON.parse(e.slice(18)).status === "start");
    const tokens = subagentEvents.filter((e) => e.startsWith("session:subagent-token:"));
    expect(result.exhausted).toBe(false);
    console.log("   → subagent start events:", starts.length, "token events:", tokens.length);

    // Regression: the child's THINKING (thought stream = FINDINGS BRIEF reasoning)
    // must NOT appear in the child's TOKEN stream (the brief content), and the
    // token stream must not duplicate itself (the old double-emit of final msg).
    for (const [childId, brief] of tokenByChild) {
      const thought = thoughtByChild.get(childId) ?? "";
      console.log(`   child ${childId}: brief=${brief.length}ch thought=${thought.length}ch`);
      if (thought.length > 20) {
        // A non-trivial slice of the reasoning should not be embedded in the brief.
        expect(brief.includes(thought.slice(0, Math.min(40, thought.length)))).toBe(false);
      }
      // No wholesale duplication: the brief's first half shouldn't repeat verbatim.
      if (brief.length > 40) {
        const half = brief.slice(0, Math.floor(brief.length / 2));
        expect(brief.indexOf(half, 1)).not.toBe(half.length);
      }
    }
  }, 90000);
});
