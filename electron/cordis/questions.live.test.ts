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

// Live proof of the dsh user-questions seam migration: ask_questions now BLOCKS
// the turn (via ctx.userQuestions.ask()) until the "renderer" answers through
// registerPending, and the answer is fed back as the tool result IN THE SAME
// TURN — so the model can use it to complete its reply. Gated on CORDIS_LIVE=1.
describe("cairn-questions (gated on CORDIS_LIVE=1)", () => {
  it("blocks on ask_questions and feeds the answer back same-turn", async () => {
    if (process.env.CORDIS_LIVE !== "1") return;
    const db = makeDb();
    const sent: Array<{ channel: string; payload: Record<string, unknown> }> = [];
    const pending = new Map<string, (t: string) => void>();

    const req: ChatRequest = {
      message: "Before answering, you MUST call the ask_questions tool to ask the user for their favorite color (a single question). After they answer, reply with exactly: 'Your favorite color is <color>.'",
      threadId: "thr-q-1",
      projectId: "pj",
      workspaceId: "ws",
    };

    const result = await runCordisLoop({
      db,
      req,
      workspacePath: "/tmp",
      llmConfig: { baseUrl: BASE, model: MODEL, apiKey: "", provider: "openai" },
      signal: undefined,
      questions: {
        send: (channel, payload) => {
          sent.push({ channel, payload });
          // Simulate the renderer answering the blocking ask_questions form:
          // resolve the pending request with a structured answer JSON.
          if (channel === "chat:tool-call" && payload.tool === "ask_questions") {
            const requestId = String(payload.callId);
            const questions = (payload.args as { questions?: Array<{ id: string }> }).questions ?? [];
            const answers = questions.map((q) => ({ id: q.id, selected: [], custom: "teal" }));
            // Answer on the next tick, mimicking a user submitting the form.
            setTimeout(() => pending.get(requestId)?.(JSON.stringify({ answers })), 10);
          }
        },
        registerPending: (requestId, resolve) => {
          pending.set(requestId, resolve);
          return () => pending.delete(requestId);
        },
      },
    });

    console.log("QUESTIONS RESULT:", JSON.stringify(result));
    console.log("QUESTIONS SENT:", sent.map((s) => s.channel + (s.payload.tool ? `:${s.payload.tool}` : "")).join(", "));

    // The ask_questions form was surfaced to the renderer.
    const askEvents = sent.filter((s) => s.channel === "chat:tool-call" && s.payload.tool === "ask_questions");
    expect(askEvents.length).toBeGreaterThanOrEqual(1);
    // The model used the same-turn answer ("teal") to complete its reply.
    expect(result.content.toLowerCase()).toContain("teal");
  }, 90000);
});
