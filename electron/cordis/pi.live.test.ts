import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { applySchema } from "../db/schema";
import { runCordisLoop, setSessionRoot, getSessionRoot } from "./run-cordis-loop";
import { initUsageRecorder } from "../lib/usage-recorder";
import type { ChatRequest } from "../lib/tools";

const BASE = process.env.CORDIS_TEST_BASE_URL ?? "http://localhost:3042/v1";
const MODEL = process.env.CORDIS_TEST_MODEL ?? "claude-sonnet-4-5";

// Route dsh's jsonl session logs to a temp dir. Chat transcripts are persisted
// as jsonl session zips by dsh-session-persistence-jsonl — NOT in Cairn's
// SQLite (there is no chat_messages transcript anymore), so persistence is
// verified against the session store on disk, not the DB.
setSessionRoot(path.join(os.tmpdir(), `cairn-pi-live-sessions-${process.pid}`));

/** True if the jsonl session store wrote any session log under its root
 *  (…/<projectKey>/<encoded-id>/session.jsonl[.zstd]). */
function sessionLogWritten(root: string): boolean {
  if (!fs.existsSync(root)) return false;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) stack.push(full);
      else if (ent.name.startsWith("session.jsonl")) return true;
    }
  }
  return false;
}

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

    // Persistence is jsonl-on-disk (dsh session-persistence-jsonl), not a
    // chat_messages DB table: the session log was written under the session root.
    expect(sessionLogWritten(getSessionRoot())).toBe(true);
    // cairn-usage wrote an llm_usage row for this session (usage IS tracked in
    // the DB — this proves the usage-recorder plugin wiring against session events).
    const usageRows = db.prepare("SELECT COUNT(*) AS n FROM llm_usage WHERE session_id = 'thr-live-2'").get() as { n: number };
    console.log("PERSISTED session log:", sessionLogWritten(getSessionRoot()), "usage rows:", usageRows.n);
    expect(usageRows.n).toBeGreaterThan(0);
  }, 120000);

  it("streams token deltas live and carries prior-turn context via the persisted session", async () => {
    if (process.env.CORDIS_LIVE !== "1") return;
    const db = makeDb();
    initUsageRecorder(db);
    // Context is carried by the stable SessionId (chat-<threadId>) + persisted
    // jsonl — NOT by a req.history transcript folded into the prompt (production
    // always passes history:[]; the session is the source of truth). So we prove
    // recall the real way: two turns on the SAME threadId. Turn 1 plants the
    // codeword; turn 2 (new call, empty history) must recall it from the session.
    const threadId = `thr-live-hist-${Date.now()}`;
    const base = { threadId, projectId: "pj", workspaceId: "ws", history: [] as ChatRequest["history"] };

    // Turn 1: plant the codeword.
    const r1 = await runCordisLoop({
      db,
      req: { ...base, message: "Remember this: the secret codeword is Zephyr. Reply with only 'ok'." },
      workspacePath: "/tmp",
      llmConfig: { baseUrl: BASE, model: MODEL, apiKey: "", provider: "openai" },
      signal: undefined,
    });
    console.log("HISTORY TURN1:", JSON.stringify(r1.content));
    expect(r1.content.length).toBeGreaterThan(0);

    // Turn 2: recall — streamed, with reasoning, from the persisted session.
    const tokens: string[] = [];
    const thoughts: string[] = [];
    const result = await runCordisLoop({
      db,
      req: { ...base, message: "Think briefly, then tell me the secret codeword I gave you. Reply with just the word." },
      workspacePath: "/tmp",
      llmConfig: { baseUrl: BASE, model: MODEL, apiKey: "", provider: "openai" },
      signal: undefined,
      onToken: (d) => tokens.push(d),
      onThought: (d) => thoughts.push(d),
    });
    console.log("HISTORY TURN2:", JSON.stringify(result), "text deltas:", tokens.length, "thought deltas:", thoughts.length);
    // Context carried: the model recovered the codeword from the persisted session.
    expect(result.content.toLowerCase()).toContain("zephyr");
    // Live streaming: onToken fired with incremental deltas whose concat equals content.
    expect(tokens.length).toBeGreaterThan(0);
    expect(tokens.join("")).toBe(result.content);
    // Reasoning captured: onThought fired and the return value carries the text.
    expect(result.reasoning.length).toBeGreaterThan(0);
    expect(thoughts.join("")).toBe(result.reasoning);
  }, 120000);
});
