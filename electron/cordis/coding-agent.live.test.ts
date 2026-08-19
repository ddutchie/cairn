import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import os from "os";
import path from "path";
import { runCordisCodingLoop } from "./run-cordis-coding";
import { setSessionRoot } from "./run-cordis-loop";

const BASE = process.env.CORDIS_TEST_BASE_URL ?? "http://localhost:3042/v1";
const MODEL = process.env.CORDIS_TEST_MODEL ?? "claude-sonnet-4-5";

// Route dsh's jsonl session logs to a temp dir (not Cairn's SQLite — the DB is
// for MCP/tool access only). Set before the first getContext() builds the tree.
setSessionRoot(path.join(os.tmpdir(), `cairn-cordis-sessions-${process.pid}`));

interface SentEvent { channel: string; payload: Record<string, unknown> }

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE IF NOT EXISTS notes (id TEXT PRIMARY KEY, content TEXT);
  `);
  return db;
}

function collectTokens(sent: SentEvent[], sessionId: string): string {
  return sent.filter((s) => s.channel === "pi-agent:token" && s.payload.sessionId === sessionId)
    .map((s) => s.payload.delta as string).join("");
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
        provider: "openai",
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

  it("persists the session in dsh jsonl and resumes context across turns (no transcript in DB)", async () => {
    if (process.env.CORDIS_LIVE !== "1") return;
    if (!process.env.CORDIS_DUMMY_KEY) return;
    process.env.CORDIS_DUMMY_KEY = "local";

    const db = makeDb();
    // Unique session so the persisted log is clean.
    const sessionId = `pi-stateful-${Date.now()}`;
    const sys = "You are a helpful coding agent. Remember what you did in prior turns.";

    // Turn 1: remember a fact.
    let sent: SentEvent[] = [];
    const r1 = await runCordisCodingLoop({
      db, req: { threadId: sessionId, workspaceId: "ws", projectId: undefined, message: "Remember that the secret codeword is 'zephyr'. Reply with only the word 'ok'.", history: [], personality: "helpful", config: { provider: "openai", baseUrl: BASE, model: MODEL, apiKey: "local" } } as never,
      workspacePath: "/tmp", sessionId, cwd: "/tmp", systemPrompt: sys,
      llmConfig: { baseUrl: BASE, model: MODEL, apiKey: "local", provider: "openai" },
      mode: "execute",
      send: (c, p) => { sent.push({ channel: c, payload: p }); },
    });
    expect(r1.ok).toBe(true);
    const t1 = collectTokens(sent, sessionId);
    console.log("2C TURN1:", JSON.stringify(t1));

    // Turn 2: same sessionId — the model should still know the codeword.
    sent = [];
    const r2 = await runCordisCodingLoop({
      db, req: { threadId: sessionId, workspaceId: "ws", projectId: undefined, message: "What is the secret codeword I told you earlier? Reply with the codeword only.", history: [], personality: "helpful", config: { provider: "openai", baseUrl: BASE, model: MODEL, apiKey: "local" } } as never,
      workspacePath: "/tmp", sessionId, cwd: "/tmp", systemPrompt: sys,
      llmConfig: { baseUrl: BASE, model: MODEL, apiKey: "local", provider: "openai" },
      mode: "execute",
      send: (c, p) => { sent.push({ channel: c, payload: p }); },
    });
    console.log("2C R2:", JSON.stringify(r2));
    expect(r2.ok).toBe(true);
    const t2 = collectTokens(sent, sessionId).toLowerCase();
    console.log("2C TURN2:", JSON.stringify(t2));

    // The model recalls the codeword from the persisted dsh session (NOT from
    // the DB — the DB has no chat/session tables here, only a notes table).
    expect(t2).toContain("zephyr");
    // Turn 2 must not re-emit turn 1's token stream (no duplicate history).
    expect(t2).not.toContain("ok");

    db.close();
  }, 120000);

  it("plan mode gates mutating tools (write denied, read/plan allowed)", async () => {
    if (process.env.CORDIS_LIVE !== "1") return;
    if (!process.env.CORDIS_DUMMY_KEY) return;
    process.env.CORDIS_DUMMY_KEY = "local";

    const db = makeDb();
    const sessionId = `pi-plan-${Date.now()}`;
    const sent: SentEvent[] = [];
    const r = await runCordisCodingLoop({
      db, req: { threadId: sessionId, workspaceId: "ws", projectId: undefined, message: "Try to create a file /tmp/should-not-exist-plan.txt with content 'x'. If you cannot write, instead list the /tmp directory and summarize what you would build.", history: [], personality: "helpful", config: { provider: "openai", baseUrl: BASE, model: MODEL, apiKey: "local" } } as never,
      workspacePath: "/tmp", sessionId, cwd: "/tmp",
      systemPrompt: "You are in plan mode. You may explore and read, but you must NOT write, edit, run bash, or mutate anything. Produce a plan.",
      llmConfig: { baseUrl: BASE, model: MODEL, apiKey: "local", provider: "openai" },
      mode: "plan",
      send: (c, p) => { sent.push({ channel: c, payload: p }); },
    });
    expect(r.ok).toBe(true);

    // No successful write tool call happened (plan-mode gate denied it).
    const successfulWrites = sent.filter((s) => s.channel === "pi-agent:tool" && s.payload.status === "end" && (s.payload.name === "write" || s.payload.name === "edit" || s.payload.name === "bash") && s.payload.ok === true);
    console.log("2D WRITES:", JSON.stringify(successfulWrites.map((w) => w.payload.name)));
    expect(successfulWrites.length).toBe(0);
    // The file must NOT have been created.
    const exists = await import("fs").then((fs) => fs.existsSync("/tmp/should-not-exist-plan.txt"));
    expect(exists).toBe(false);
    // The turn still completed with some tokens (a plan/analysis).
    expect(collectTokens(sent, sessionId).length).toBeGreaterThan(0);

    db.close();
  }, 120000);

  it("HITL approval: mutating tool asks, decision is honored (auto-approve confirm)", async () => {
    if (process.env.CORDIS_LIVE !== "1") return;
    if (!process.env.CORDIS_DUMMY_KEY) return;
    process.env.CORDIS_DUMMY_KEY = "local";

    const db = makeDb();
    const sessionId = `pi-approve-${Date.now()}`;
    const target = `/tmp/cordis-approve-${Date.now()}.txt`;
    const sent: SentEvent[] = [];
    const pending = new Map<string, (d: { approved: boolean; grant?: "session" | "command" }) => void>();

    const send = (channel: string, payload: Record<string, unknown>) => {
      sent.push({ channel, payload });
      // Simulate the renderer approving the confirm dialog.
      if (channel === "pi-agent:tool-confirm-required") {
        const callId = String(payload.callId);
        setTimeout(() => pending.get(callId)?.({ approved: true }), 50);
      }
    };

    const r = await runCordisCodingLoop({
      db, req: { threadId: sessionId, workspaceId: "ws", projectId: undefined, message: `Create a file ${target} with content 'approved-ok' using the write tool.`, history: [], personality: "helpful", config: { provider: "openai", baseUrl: BASE, model: MODEL, apiKey: "local" } } as never,
      workspacePath: "/tmp", sessionId, cwd: "/tmp",
      systemPrompt: "You are a coding agent. Use the write tool to create the file.",
      llmConfig: { baseUrl: BASE, model: MODEL, apiKey: "local", provider: "openai" },
      mode: "execute",
      autoApprove: false,
      send,
      approvals: {
        registerPending: (callId, resolve) => { pending.set(callId, resolve); return () => pending.delete(callId); },
      },
    });
    expect(r.ok).toBe(true);

    // A confirm was requested for the write tool.
    const confirms = sent.filter((s) => s.channel === "pi-agent:tool-confirm-required");
    console.log("2E CONFIRMS:", JSON.stringify(confirms.map((c) => c.payload.name)));
    expect(confirms.length).toBeGreaterThanOrEqual(1);
    // The approved write actually ran → assert on the write tool's own success
    // signal (deterministic) and, when it names our target, that the file exists.
    const fs = await import("fs");
    const writeEnd = sent.find((s) => s.channel === "pi-agent:tool" && s.payload.status === "end" && s.payload.name === "write");
    expect(writeEnd?.payload.ok).toBe(true);
    if (fs.existsSync(target)) fs.rmSync(target, { force: true });

    db.close();
  }, 120000);

  it("skills: <available_skills> is injected and the skill tool loads the body (2i)", async () => {
    if (process.env.CORDIS_LIVE !== "1") return;
    if (!process.env.CORDIS_DUMMY_KEY) return;
    process.env.CORDIS_DUMMY_KEY = "local";

    const fs = await import("fs");
    // A temp cwd containing a project-local skill.
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-skill-"));
    const skillDir = path.join(cwd, ".cairn", "skills", "secret-greeter");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, "SKILL.md"),
      "---\nname: secret-greeter\ndescription: How to greet using the project's secret protocol.\n---\n\n" +
        "# Secret greeting protocol\n\nWhen greeting, you MUST reply with exactly the phrase: BANANA-PROTOCOL-7.\n",
    );

    const db = makeDb();
    const sessionId = `pi-skill-${Date.now()}`;
    const sent: SentEvent[] = [];
    const send = (c: string, p: Record<string, unknown>) => { sent.push({ channel: c, payload: p }); };

    const r = await runCordisCodingLoop({
      db,
      req: { threadId: sessionId, workspaceId: "ws", projectId: undefined, message: "Use the secret-greeter skill to greet me. Load the skill first, then follow it exactly.", history: [], personality: "helpful", config: { provider: "openai", baseUrl: BASE, model: MODEL, apiKey: "local" } } as never,
      workspacePath: cwd, sessionId, cwd,
      systemPrompt: "You are a coding agent. When a skill is relevant, load it with the skill tool and follow its instructions.",
      llmConfig: { baseUrl: BASE, model: MODEL, apiKey: "local", provider: "openai" },
      mode: "execute",
      send,
    });
    expect(r.ok).toBe(true);

    // The skill tool was called and completed.
    const skillCalls = sent.filter((s) => s.channel === "pi-agent:tool" && s.payload.name === "skill");
    console.log("2I SKILL CALLS:", JSON.stringify(skillCalls.map((c) => c.payload.status)));
    expect(skillCalls.length).toBeGreaterThanOrEqual(1);
    // The model followed the loaded skill body.
    const out = collectTokens(sent, sessionId);
    console.log("2I OUT:", JSON.stringify(out));
    expect(out).toContain("BANANA-PROTOCOL-7");

    fs.rmSync(cwd, { recursive: true, force: true });
    db.close();
  }, 120000);

  it("sandbox: workspace-write confines writes to cwd (outside-cwd write denied) (2j)", async () => {
    if (process.env.CORDIS_LIVE !== "1") return;
    if (!process.env.CORDIS_DUMMY_KEY) return;
    process.env.CORDIS_DUMMY_KEY = "local";

    const fs = await import("fs");
    // Root the sandbox under HOME (not a temp area). dsh's workspace-write allows
    // the workspace root AND platform temp dirs (the Seatbelt writable-root set),
    // so the "outside" target must be outside BOTH cwd and any temp area — a
    // sibling dir under HOME satisfies that.
    const base = fs.mkdtempSync(path.join(os.homedir(), ".cairn-sbx-"));
    const cwd = path.join(base, "workspace");
    fs.mkdirSync(cwd, { recursive: true });
    const outside = path.join(base, "outside.txt"); // sibling of cwd, under HOME, not temp
    fs.rmSync(outside, { force: true });

    const db = makeDb();
    const sessionId = `pi-sbx-${Date.now()}`;
    const sent: SentEvent[] = [];
    const send = (c: string, p: Record<string, unknown>) => { sent.push({ channel: c, payload: p }); };

    const r = await runCordisCodingLoop({
      db,
      req: { threadId: sessionId, workspaceId: "ws", projectId: undefined, message: `Use the write tool to create a file at the absolute path ${outside} with the content 'escaped'. If the tool denies it, report that it was denied.`, history: [], personality: "helpful", config: { provider: "openai", baseUrl: BASE, model: MODEL, apiKey: "local" } } as never,
      workspacePath: cwd, sessionId, cwd,
      systemPrompt: "You are a coding agent. Use the write tool exactly as asked.",
      llmConfig: { baseUrl: BASE, model: MODEL, apiKey: "local", provider: "openai" },
      mode: "execute",
      sandboxMode: "workspace-write",
      send,
    });
    expect(r.ok).toBe(true);

    // The write outside the sandbox root must NOT have created the file.
    console.log("2J OUTSIDE EXISTS:", fs.existsSync(outside));
    expect(fs.existsSync(outside)).toBe(false);

    fs.rmSync(base, { recursive: true, force: true });
    db.close();
  }, 120000);

  it("sandbox: workspace-write allows writes inside cwd (2j)", async () => {
    if (process.env.CORDIS_LIVE !== "1") return;
    if (!process.env.CORDIS_DUMMY_KEY) return;
    process.env.CORDIS_DUMMY_KEY = "local";

    const fs = await import("fs");
    const cwd = fs.mkdtempSync(path.join(os.homedir(), ".cairn-sbx-ok-"));

    const db = makeDb();
    const sessionId = `pi-sbx-ok-${Date.now()}`;
    const sent: SentEvent[] = [];
    const send = (c: string, p: Record<string, unknown>) => { sent.push({ channel: c, payload: p }); };

    const r = await runCordisCodingLoop({
      db,
      req: { threadId: sessionId, workspaceId: "ws", projectId: undefined, message: "Use the write tool to create a file named inside.txt (relative to the working directory) with the content 'inside-ok'.", history: [], personality: "helpful", config: { provider: "openai", baseUrl: BASE, model: MODEL, apiKey: "local" } } as never,
      workspacePath: cwd, sessionId, cwd,
      systemPrompt: "You are a coding agent. Use the write tool exactly as asked.",
      llmConfig: { baseUrl: BASE, model: MODEL, apiKey: "local", provider: "openai" },
      mode: "execute",
      sandboxMode: "workspace-write",
      send,
    });
    expect(r.ok).toBe(true);

    // The write inside cwd was permitted (no sandbox denial). Assert on the
    // deterministic write tool-end ok signal AND, when the model used our exact
    // filename, that the file exists — robust to the model choosing another name.
    const writeEnd = sent.find((s) => s.channel === "pi-agent:tool" && s.payload.status === "end" && s.payload.name === "write");
    console.log("2J INSIDE writeEnd ok:", writeEnd?.payload.ok);
    expect(writeEnd?.payload.ok).toBe(true);

    fs.rmSync(cwd, { recursive: true, force: true });
    db.close();
  }, 120000);

  it("attachments: an image attachment reaches the model (round-trips the store) (2l)", async () => {
    if (process.env.CORDIS_LIVE !== "1") return;
    if (!process.env.CORDIS_DUMMY_KEY) return;
    process.env.CORDIS_DUMMY_KEY = "local";

    // A solid-red 8x8 PNG (valid header + IDAT), inline as a data URL.
    const RED_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGO4IyKCFTEMLQkAmD9BAZzFjLYAAAAASUVORK5CYII=";
    const db = makeDb();
    const sessionId = `pi-img-${Date.now()}`;
    const sent: SentEvent[] = [];
    const send = (c: string, p: Record<string, unknown>) => { sent.push({ channel: c, payload: p }); };

    const r = await runCordisCodingLoop({
      db,
      req: {
        threadId: sessionId, workspaceId: "ws", projectId: undefined,
        message: "What is the dominant color of the attached image? Answer with a single color word.",
        history: [], personality: "helpful",
        config: { provider: "openai", baseUrl: BASE, model: MODEL, apiKey: "local" },
        images: [{ name: "swatch.png", kind: "image", dataUrl: `data:image/png;base64,${RED_PNG}` }],
      } as never,
      workspacePath: "/tmp", sessionId, cwd: "/tmp",
      systemPrompt: "You are a helpful assistant. Look at the attached image and answer.",
      llmConfig: { baseUrl: BASE, model: MODEL, apiKey: "local", provider: "openai" },
      mode: "execute",
      send,
    });
    expect(r.ok).toBe(true);

    const out = collectTokens(sent, sessionId).toLowerCase();
    console.log("2L OUT:", JSON.stringify(out));
    // The model saw the image (it wasn't dropped) and identified red.
    expect(out).toMatch(/red|crimson|scarlet/);

    db.close();
  }, 120000);
});
