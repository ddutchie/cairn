import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { runCordisCodingLoop } from "./run-cordis-coding";

const BASE = process.env.CORDIS_TEST_BASE_URL ?? "http://localhost:3042/v1";
const MODEL = process.env.CORDIS_TEST_MODEL ?? "claude-sonnet-4-5";

interface SentEvent { channel: string; payload: Record<string, unknown> }

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE IF NOT EXISTS notes (id TEXT PRIMARY KEY, content TEXT);
  `);
  return db;
}

describe("runCordisCodingLoop (gated on CORDIS_LIVE=1)", () => {
  it("drives a coding turn and emits pi-agent:* token/tool/usage/done events", async () => {
    if (process.env.CORDIS_LIVE !== "1") return;
    if (!process.env.CORDIS_DUMMY_KEY) return;
    process.env.CORDIS_DUMMY_KEY = "local";

    const db = makeDb();
    const sent: SentEvent[] = [];
    const send = (channel: string, payload: Record<string, unknown>) => { sent.push({ channel, payload }); };

    const result = await runCordisCodingLoop({
      db,
      req: {
        threadId: "pi-live",
        workspaceId: "ws",
        projectId: undefined,
        message: "Create a file /tmp/cordis-agent-live.txt with the content 'cairn-coding-ok' using the write tool, then read it back and tell me what it says.",
        history: [],
        personality: "helpful",
        config: { provider: "openai", baseUrl: BASE, model: MODEL, apiKey: "local" },
      } as never,
      workspacePath: "/tmp",
      sessionId: "pi-live-session",
      cwd: "/tmp",
      systemPrompt: "You are a helpful coding agent. Use the provided tools to complete the task.",
      llmConfig: {
        baseUrl: BASE,
        model: MODEL,
        apiKey: "local",
        maxSteps: 20,
        provider: "openai",
        contextWindow: 262144,
      },
      mode: "execute",
      send,
    });

    console.log("CODING-AGENT RESULT:", JSON.stringify(result));
    console.log("CODING-AGENT CHANNELS:", sent.map((s) => s.channel).join(", "));

    // The turn completed cleanly.
    expect(result.ok).toBe(true);

    const channels = sent.map((s) => s.channel);
    // Streaming tokens fired.
    expect(channels.some((c) => c === "pi-agent:token")).toBe(true);
    // A write tool call was made and completed.
    const toolEnds = sent.filter((s) => s.channel === "pi-agent:tool" && s.payload.status === "end");
    expect(toolEnds.length).toBeGreaterThanOrEqual(1);
    // done fired exactly once.
    expect(channels.filter((c) => c === "pi-agent:done").length).toBe(1);
    // No error.
    expect(channels.some((c) => c === "pi-agent:error")).toBe(false);
    // Every event is scoped to the session id.
    for (const s of sent) expect(s.payload.sessionId).toBe("pi-live-session");

    db.close();
  }, 120000);
});
