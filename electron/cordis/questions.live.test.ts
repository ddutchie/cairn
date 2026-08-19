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
      message: "testing the question tool — please ask me a couple of questions about my favorite color and animal, then tell me both back to me.",
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
            const questions = (payload.args as { questions?: Array<{ id: string; label?: string }> }).questions ?? [];
            // Distinct answer per question so the assertion proves the model
            // actually READ the returned answers (has context of them), not just
            // that the tool ran. Color→"chartreuse", animal→"axolotl".
            const answers = questions.map((q) => {
              const key = `${q.id} ${q.label ?? ""}`.toLowerCase();
              const custom = key.includes("animal") ? "axolotl" : "chartreuse";
              return { id: q.id, selected: [], custom };
            });
            // Answer after a delay, mimicking a real user taking time to fill the
            // form (not an instant reply) — catches the turn ending before the
            // blocking tool result comes back.
            setTimeout(() => pending.get(requestId)?.(JSON.stringify({ answers })), 2500);
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
    // The questions reached the renderer in its PendingQuestion shape
    // ({id,label,prompt}) — NOT remapped to dsh {question,header}, which would
    // render an empty, un-fillable form.
    const firstQs = (askEvents[0].payload.args as { questions?: Array<{ id?: string; label?: string; prompt?: string; question?: string }> }).questions ?? [];
    console.log("QUESTION SHAPE:", JSON.stringify(firstQs[0]));
    expect(firstQs.length).toBeGreaterThanOrEqual(1);
    expect(typeof firstQs[0].id).toBe("string");
    // Questions carry Cairn's fields (label/prompt), NOT dsh's {question,header}
    // remap that produced an empty, un-fillable form. label/prompt are what the
    // renderer shows; at least one must be present (models vary which they fill).
    expect(typeof firstQs[0].label === "string" || typeof firstQs[0].prompt === "string").toBe(true);
    expect(firstQs[0].question).toBeUndefined();
    // The model CONTINUED in the same turn and USED the returned answers — proof
    // it had context of them (the reported bug: "if I ask what I answered it has
    // no context"). At least one distinct answer must appear in the final reply.
    const reply = result.content.toLowerCase();
    expect(reply.includes("chartreuse") || reply.includes("axolotl")).toBe(true);
  }, 90000);
});
