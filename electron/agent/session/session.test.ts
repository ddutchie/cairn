import { mkdtemp, readFile, appendFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentEvent } from "../events";
import { SESSION_FILE, openSession, readSession } from "./log";
import { deriveTitle, foldState, historyFromRecords } from "./history";
import { createAdapter } from "./adapter";

const usage = { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, totalTokens: 18, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 } };
const assistant = (content: AssistantMessage["content"]): AssistantMessage => ({
  role: "assistant", content, api: "openai-completions", provider: "p", model: "m", usage, stopReason: content.some((c) => c.type === "toolCall") ? "toolUse" : "stop", timestamp: 1,
});

const turn: AgentEvent[] = [
  { type: "turn/start", sessionId: "s1", profile: "chat" },
  { type: "user/message", content: "write a note\nplease" },
  { type: "assistant/delta", text: "ok" },
  { type: "assistant/message", message: assistant([{ type: "toolCall", id: "c1", name: "note_write", arguments: { t: 1 } }]) },
  { type: "tool/call", callId: "c1", name: "note_write", args: { t: 1 }, risk: "WRITE_CAIRN" },
  { type: "tool/result", callId: "c1", name: "note_write", text: "done", isError: false },
  { type: "assistant/message", message: assistant([{ type: "text", text: "all set" }]) },
  { type: "turn/end", reason: "stop" },
];

async function tmp() { return mkdtemp(path.join(os.tmpdir(), "cairn-session-")); }

describe("session log", () => {
  it("round-trips events, skips deltas, keeps assistant messages verbatim", async () => {
    const root = await tmp();
    const { writer } = await openSession(root, { id: "s1" });
    for (const e of turn) await writer.append(e);
    const log = (await readSession(root, "s1"))!;
    expect(log.records.map((r) => r.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(log.records.some((r) => r.event.type === "assistant/delta")).toBe(false);
    const msgs = historyFromRecords(log.records);
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant", "toolResult", "assistant"]);
    expect(msgs[1]).toEqual(turn[3].type === "assistant/message" ? turn[3].message : null);
    expect(deriveTitle(log.records)).toBe("write a note");
  });

  it("survives a torn tail and continues the sequence", async () => {
    const root = await tmp();
    const a = await openSession(root, { id: "s2" });
    await a.writer.append(turn[1]);
    await appendFile(path.join(root, "s2", SESSION_FILE), '{"seq":2,"time":1,"even');
    const b = await openSession(root, { id: "s2" });
    expect(b.existing?.skipped).toBe(1);
    const rec = await b.writer.append(turn[7]);
    expect(rec?.seq).toBe(2);
    const text = await readFile(path.join(root, "s2", SESSION_FILE), "utf8");
    expect(text.trim().split("\n")).toHaveLength(3);
  });

  it("repairs dangling tool calls and tracks pending asks and usage", async () => {
    const root = await tmp();
    const { writer } = await openSession(root, { id: "s3" });
    const ask = { sessionId: "s3", callId: "c1", nonce: "n", tool: "bash", risk: "EXEC" as const, title: "t", preview: "p", reason: "r", grants: [], expiresAt: 1 };
    for (const e of [turn[0], turn[1], turn[3], { type: "approval/asked", ask } as AgentEvent]) await writer.append(e);
    const log = (await readSession(root, "s3"))!;
    const msgs = historyFromRecords(log.records);
    expect(msgs.at(-1)).toMatchObject({ role: "toolResult", isError: true, toolCallId: "c1" });
    const state = foldState(log.records);
    expect(state.running).toBe(true);
    expect([...state.pendingAsks.keys()]).toEqual(["c1"]);
    expect(state.usage).toMatchObject({ input: 10, output: 5, costUsd: 0.01 });
  });

  it("rejects path-traversing ids", async () => {
    await expect(openSession(await tmp(), { id: "../x" })).rejects.toThrow(/invalid session id/);
  });
});

describe("adapter", () => {
  it("emits dsh-shaped events the renderer fold understands", async () => {
    const { createSessionEventFold } = await import("../../../shared/agent/session-event-fold");
    const out: string[] = [];
    const fold = createSessionEventFold({
      onText: (t) => out.push(`text:${t}`),
      onToolCall: (c) => out.push(`call:${c.name}`),
      onToolResult: (r) => out.push(`result:${r.ok}:${r.output}`),
      onTurnEnd: (k) => out.push(`end:${k}`),
      onUsage: (u) => out.push(`usage:${u.promptTokens}`),
    });
    const adapt = createAdapter("s1", () => 0);
    const projections: string[] = [];
    for (const e of turn) {
      const a = adapt(e);
      a.events.forEach((x) => fold(x));
      projections.push(...a.projections.map((p) => p.kind));
    }
    expect(out).toContain("call:note_write");
    expect(out).toContain("result:true:done");
    expect(out.at(-1)).toBe("end:stop");
    expect(out).toContain("text:ok");
    expect(projections).toEqual([]);
  });

  it("projects approvals with their nonce", () => {
    const adapt = createAdapter("s1");
    const { projections } = adapt({ type: "approval/asked", ask: { sessionId: "s1", callId: "c", nonce: "n1", tool: "bash", risk: "EXEC", title: "Run", preview: "ls", reason: "r", grants: [], expiresAt: 5 } });
    expect(projections[0]).toMatchObject({ kind: "approval", data: { status: "required", callId: "c", nonce: "n1", name: "bash" } });
    expect(adapt({ type: "approval/decided", callId: "c", approved: true, by: "human" }).projections[0]).toMatchObject({ kind: "approval", data: { status: "resolved", callId: "c" } });
  });
});
