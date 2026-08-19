import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";

import { applySchema } from "../db/schema";
import { runCordisLoop } from "./run-cordis-loop";
import { getChatThreads, getChatMessages } from "../db/queries";
import { initUsageRecorder } from "../lib/usage-recorder";
import type { ChatRequest } from "../lib/tools";

const BASE = process.env.CORDIS_TEST_BASE_URL ?? "http://localhost:3042/v1";
const MODEL = process.env.CORDIS_TEST_MODEL ?? "claude-sonnet-4-5";

function makeDb() {
  const db = new Database(":memory:");
  applySchema(db);
  const now = new Date().toISOString();
  db.prepare("INSERT INTO workspaces (id, name, created_at, updated_at) VALUES ('ws', 'W', ?, ?)").run(now, now);
  db.prepare("INSERT INTO projects (id, workspace_id, name, created_at, updated_at) VALUES ('pj', 'ws', 'P', ?, ?)").run(now, now);
  for (const title of ["Alpha note", "Beta note", "Gamma note"]) {
    db.prepare("INSERT INTO notes (id, project_id, workspace_id, title, content, created_at, updated_at) VALUES (?, 'pj', 'ws', ?, ?, ?, ?)").run("n-" + title, title, title, now, now);
  }
  return db;
}

// Live end-to-end proof of the Phase 1 engine swap: runCordisLoop drives the
// dsh agent loop with Cairn's tools bridged on, using the production
// dsh-llm-pi-ai responses adapter. Gated on CORDIS_LIVE=1 (needs a reachable
// OpenAI-compatible endpoint — the Rork bridge at localhost:3042 in dev).
describe("runCordisLoop (gated on CORDIS_LIVE=1)", () => {
  it("drives a tool-calling turn through the dsh agent loop", async () => {
    if (process.env.CORDIS_LIVE !== "1") return;
    const db = makeDb();
    // Point the usage recorder at this in-memory DB so cairn-usage writes are
    // visible (in production the cairnDb handle == the recorder's activeDb).
    initUsageRecorder(db);
    const tokens: string[] = [];
    const req: ChatRequest = { message: "Use the get_active_context tool and report the project name.", threadId: "thr-live-2", projectId: "pj", workspaceId: "ws" };
    const result = await runCordisLoop({
      db,
      req,
      workspacePath: "/tmp",
      llmConfig: { baseUrl: BASE, model: MODEL, apiKey: "", provider: "openai" },
      signal: undefined,
      onToken: (d) => tokens.push(d),
    });
    console.log("RUN-CORDIS-LOOP RESULT:", JSON.stringify(result));
    console.log("RUN-CORDIS-LOOP TOKENS:", tokens.join(""));
    expect(result.content.length).toBeGreaterThan(0);

    // cairn-session plugin persisted the thread + messages; cairn-usage wrote
    // an llm_usage row. This proves the plugin wiring against real session events.
    const threads = getChatThreads(db, "ws");
    expect(threads.map((t) => t.id)).toContain("thr-live-2");
    const msgs = getChatMessages(db, "thr-live-2");
    expect(msgs.length).toBeGreaterThanOrEqual(1);
    const usageRows = db.prepare("SELECT COUNT(*) AS n FROM llm_usage WHERE session_id = 'thr-live-2'").get() as { n: number };
    console.log("PERSISTED messages:", msgs.length, "usage rows:", usageRows.n);
    expect(usageRows.n).toBeGreaterThan(0);
  });

  it("streams token deltas live and carries prior-turn context (history)", async () => {
    if (process.env.CORDIS_LIVE !== "1") return;
    const db = makeDb();
    initUsageRecorder(db);
    const tokens: string[] = [];
    const thoughts: string[] = [];
    // The answer ("Zephyr") only exists in the prior turn — the model must use
    // the replayed history (folded into the system prompt) to answer correctly.
    const req: ChatRequest = {
      message: "Think briefly, then tell me the secret codeword I gave you. Reply with just the word.",
      threadId: "thr-live-hist",
      projectId: "pj",
      workspaceId: "ws",
      history: [
        { role: "user", content: "Remember this: the secret codeword is Zephyr." },
        { role: "assistant", content: "Got it — I'll remember the codeword is Zephyr." },
      ],
    };
    const result = await runCordisLoop({
      db,
      req,
      workspacePath: "/tmp",
      llmConfig: { baseUrl: BASE, model: MODEL, apiKey: "", provider: "openai" },
      signal: undefined,
      onToken: (d) => tokens.push(d),
      onThought: (d) => thoughts.push(d),
    });
    console.log("HISTORY RESULT:", JSON.stringify(result), "text deltas:", tokens.length, "thought deltas:", thoughts.length);
    // Context carried: the model recovered the codeword from replayed history.
    expect(result.content.toLowerCase()).toContain("zephyr");
    // Live streaming: onToken fired with incremental deltas (not one final blob),
    // and the concatenated deltas equal the final content.
    expect(tokens.length).toBeGreaterThan(0);
    expect(tokens.join("")).toBe(result.content);
    // Reasoning was captured (completions streams reasoning-delta; the fallback
    // reads the final message's reasoning block). onThought fired and the return
    // value carries the reasoning text.
    expect(result.reasoning.length).toBeGreaterThan(0);
    expect(thoughts.join("")).toBe(result.reasoning);
  });
});
