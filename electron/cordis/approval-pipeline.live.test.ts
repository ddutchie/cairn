/**
 * LIVE validation of the refactored approval pipeline (docs/approval-gating-audit.md).
 * Opt-in: CORDIS_LIVE=1 npx vitest run electron/cordis/approval-pipeline.live.test.ts
 *
 * Exercises against a real model (default bridge :3042 / claude-sonnet-4-5):
 *   1. HITL ask → user DENY: confirm-required fires, denial feeds back, turn ok.
 *   2. Session grant: first write asks with grant:'session' → later writes never re-ask;
 *      the durable grant store records the tool.
 *   3. Plugin confirm seam: an extraTool calls ctx.cairn.confirm() mid-turn; the
 *      synthetic chip/card pipeline carries it and the outcome returns to the tool.
 *   4. Doom-loop pilot: repeated identical bash trips the threshold → confirm via
 *      ctx.cairn.confirm → scripted reject halts the call with the doom reason.
 */
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import os from "os";
import path from "path";
import fs from "fs";
import { runCordisCodingLoop } from "./run-cordis-coding";
import { setSessionRoot } from "./run-cordis-loop";
import { applySchema } from "../db/schema";
import { createInteractiveConfirmTransport, setConfirmTransport } from "./approval-transports";
import { clearSessionGrants, getSessionGrants } from "./approval-grants";
import { getContext, readContextRing } from "./run-cordis-loop";

const BASE = process.env.CORDIS_TEST_BASE_URL ?? "http://localhost:3042/v1";
const MODEL = process.env.CORDIS_TEST_MODEL ?? "claude-sonnet-4-5";

setSessionRoot(path.join(os.tmpdir(), `cairn-cordis-sessions-${process.pid}`));

interface SentEvent { channel: string; payload: Record<string, unknown> }
type Decision = { approved: boolean; grant?: "session" | "command" };

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  applySchema(db);
  return db;
}

function makeSandbox(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cairn-approval-live-"));
}

const confirms = (sent: SentEvent[]) =>
  sent.filter((s) => s.channel === "pi-agent:tool-confirm-required").map((s) => s.payload as { name?: string });

async function runTurn(opts: {
  db: Database.Database; cwd: string; sessionId: string;
  message: string; send: (c: string, p: Record<string, unknown>) => void;
  autoApprove?: boolean; extraTools?: unknown[];
  /** Scripted decisions for NATIVE tool asks (the cairnApprovalPlugin bridge). */
  decisions?: Decision[];
}) {
  return runCordisCodingLoop({
    db: opts.db,
    req: {
      threadId: opts.sessionId, workspaceId: "ws-live", projectId: undefined,
      message: opts.message, history: [], personality: "helpful",
      config: { provider: "openai", baseUrl: BASE, model: MODEL, apiKey: "local" },
    } as never,
    workspacePath: opts.cwd,
    sessionId: opts.sessionId,
    cwd: opts.cwd,
    systemPrompt: "You are a helpful coding agent in a scratch sandbox. Use tools to complete the task, then answer briefly.",
    llmConfig: { baseUrl: BASE, model: MODEL, apiKey: "local", provider: "openai" },
    mode: "execute",
    autoApprove: opts.autoApprove,
    send: opts.send,
    extraTools: opts.extraTools as never,
    // Native bridge: same shape pi-agent binds in production. Scripted answers.
    ...(opts.decisions ? {
      approvals: {
        registerPending: (_callId: string, resolve: (d: Decision) => void) => {
          const next = opts.decisions!.shift() ?? { approved: false };
          setTimeout(() => resolve(next), 0);
          return () => {};
        },
      },
    } : {}),
  });
}

const finalText = (sent: SentEvent[]) =>
  sent.filter((s) => s.channel === "pi-agent:token")
    .map((s) => (s.payload as { delta?: string }).delta ?? "").join("");

describe.skipIf(process.env.CORDIS_LIVE !== "1")("approval pipeline (LIVE, gated on CORDIS_LIVE=1) (SKIPPED by default)", () => {
  it("scenarios 1+2+4 share one session: deny → session-grant → doom reject", async () => {
    const db = makeDb();
    const cwd = makeSandbox();
    const sessionId = `pi-appr-${Date.now()}`;
    const sent: SentEvent[] = [];
    const send = (channel: string, payload: Record<string, unknown>) => {
      if (channel === "pi-agent:token") return; // keep the log readable
      sent.push({ channel, payload });
    };
    clearSessionGrants(sessionId);

    // ── Scenario 1: write asks, we DENY ──────────────────────────────────
    const r1 = await runTurn({
      db, cwd, sessionId, send, autoApprove: false,
      message: `Use the write tool to create ${path.join(cwd, "deny-me.txt")} containing "nope". If the write was not executed, reply exactly BLOCKED.`,
      decisions: [{ approved: false }],
    });
    console.log("[live] scenario1 RESULT:", JSON.stringify(r1));
    expect(r1.ok).toBe(true);
    const c1 = confirms(sent);
    console.log("[live] scenario1 confirms:", c1.map((c) => c.name));
    expect(c1.length).toBeGreaterThanOrEqual(1);
    expect(getSessionGrants(sessionId).tools.size).toBe(0); // denial records nothing

    // ── Scenario 2: first write asks w/ session grant → later writes free ─
    // Fresh session: scenario 1's denial history makes the model second-guess
    // (it asked a question instead of acting). Grant persistence across turns
    // is unit-covered; live validates the within-turn single-ask behaviour.
    const sessionId2 = `${sessionId}-g`;
    clearSessionGrants(sessionId2);
    console.log("[live] scenario2 pre-grants:", [...getSessionGrants(sessionId2).tools]);
    sent.length = 0;
    const r2 = await runTurn({
      db, cwd, sessionId: sessionId2, send, autoApprove: false,
      message: `You MUST create both files using the write tool (never bash): ${path.join(cwd, "a.txt")} with content "A", then ${path.join(cwd, "b.txt")} with content "B". Only after both writes succeed, reply DONE.`,
      decisions: [{ approved: true, grant: "session" }],
    });
    console.log("[live] scenario2 RESULT:", JSON.stringify(r2), "| sentChannels:", sent.length);
    expect(r2.ok).toBe(true);
    const c2 = confirms(sent);
    const toolEvents = sent.filter((s) => s.channel === "pi-agent:tool").map((s) => `${(s.payload as { name?: string }).name}:${(s.payload as { status?: string }).status}`);
    console.log("[live] scenario2 confirm count:", c2.length, c2.map((c) => c.name));
    console.log("[live] scenario2 toolEvents:", toolEvents.join(","), "| text:", finalText(sent).slice(-80));
    console.log("[live] scenario2 files:", fs.existsSync(path.join(cwd, "a.txt")), fs.existsSync(path.join(cwd, "b.txt")));
    expect(c2.filter((c) => c.name === "write")).toHaveLength(1); // asked once, granted afterwards
    expect(getSessionGrants(sessionId2).tools.has("write")).toBe(true);
    expect(fs.existsSync(path.join(cwd, "a.txt"))).toBe(true);
    expect(fs.existsSync(path.join(cwd, "b.txt"))).toBe(true);

    // ── Scenario 4: doom-loop — repeat one bash call until the guard trips ─
    sent.length = 0;
    let doomAsks = 0;
    setConfirmTransport(sessionId, {
      confirm: async (req) => {
        doomAsks++;
        console.log("[live] doom confirm:", req.title, "/", req.detail);
        return "rejected";
      },
    });
    const r4 = await runTurn({
      db, cwd, sessionId, send,
      // autoApprove stays ON here: no native asks — the ONLY gate is doom.
      message: `Run this exact command five separate times using the bash tool: echo doom-probe-${sessionId}. Then reply LOOPED.`,
    });
    setConfirmTransport(sessionId, undefined);
    expect(doomAsks).toBeGreaterThanOrEqual(1);
    expect(r4.ok).toBe(true); // halted gracefully, not crashed
    const haltVisible = JSON.stringify(sent).includes("repeated identical tool call");
    console.log("[live] scenario4 doom reason visible:", haltVisible);
  }, 300_000);

  it("scenario 3: plugin confirm seam end-to-end inside a real turn", async () => {
    const db = makeDb();
    const cwd = makeSandbox();
    const sessionId = `pi-plug-${Date.now()}`;
    const sent: SentEvent[] = [];
    const send = (channel: string, payload: Record<string, unknown>) => sent.push({ channel, payload });
    clearSessionGrants(sessionId);

    setConfirmTransport(sessionId, createInteractiveConfirmTransport({
      sessionId,
      send,
      registerPending: (_callId, resolve) => {
        setTimeout(() => resolve({ approved: true }), 0);
        return () => {};
      },
    }));
    const requestApproval = {
      name: "request_approval",
      description: "Ask the human to approve publishing the summary. You MUST call this tool exactly once before replying.",
      parameters: {}, // dsh property-map shape (defineTool builds the object wrapper)
      execute: async () => {
        const ctx = await getContext();

        const outcome = await (ctx as unknown as { cairn?: { confirm?: (sid: string, opts: unknown) => Promise<string> } }).cairn?.confirm?.(sessionId, {
          title: "Publish the scratch summary?",
          detail: "Plugin-mediated confirmation (ctx.cairn.confirm)",
          toolName: "publish_summary",
        });

        console.log("[live] plugin confirm outcome:", outcome);
        return { approved: outcome === "allowed-once" };
      },
    };
    const r = await runTurn({
      db, cwd, sessionId, send, autoApprove: true,
      message: "Call the request_approval tool once (it is mandatory), then reply APPROVED:true or APPROVED:false based on its result.",
      extraTools: [requestApproval],
    });
    setConfirmTransport(sessionId, undefined);

    expect(r.ok).toBe(true);
    console.log("[live] scenario3 channels:", [...new Set(sent.map((s) => s.channel))].join(","));
    // The plugin ask rode the native card pipeline:
    const chip = sent.find((s) => s.channel === "pi-agent:tool"
      && (s.payload as { name?: string }).name === "publish_summary"
      && (s.payload as { status?: string }).status === "pending");
    expect(chip).toBeTruthy();
    const card = confirms(sent).find((c) => c.name === "publish_summary");
    expect(card).toBeTruthy();
    // And the model saw the approval:
    const text = finalText(sent);
    console.log("[live] scenario3 final text:", text.slice(-120));
    expect(text.includes("APPROVED:true")).toBe(true);
  }, 180_000);

  it("context ring projection populates after a real turn", async () => {
    const db = makeDb();
    const cwd = makeSandbox();
    const sessionId = `pi-ring-${Date.now()}`;
    await runTurn({
      db, cwd, sessionId,
      message: "Reply with exactly: RING-OK",
      send: () => {},
    });
    const ring = await readContextRing(sessionId);
    console.log("[live] context-ring:", JSON.stringify(ring).slice(0, 300));
    // Projection is registered + readable for a known session. Reasoning
    // buckets depend on the model emitting thinking — soft-checked via log.
    expect(ring.available).toBe(true);
  }, 120_000);
});
