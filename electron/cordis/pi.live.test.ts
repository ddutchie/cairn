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
  });
});
