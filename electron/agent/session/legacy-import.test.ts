import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { zstdCompressSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { importLegacyLog, importLegacySession, importLegacyTree } from "./legacy-import";
import { historyFromRecords, foldState } from "./history";
import { readSession } from "./log";

const jsonl = (...rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join("\n");
const user = (seq: number, text: string, source: unknown = { kind: "user" }) => ({ type: "user/message", seq, time: seq, data: { content: [{ type: "text", text }], source } });

// v0: tool-result wrapped in content[0]; v4: role "tool" message. Both appear on disk.
const v0 = jsonl(
  { type: "session", version: 0, id: "s0", createdAt: 5, cwd: "/w" },
  { type: "turn/start", seq: 1, time: 1, data: { turn: 1 } },
  user(2, "hi"),
  user(3, "<system-reminder>", { kind: "agent-instructions" }),
  { type: "session/title", seq: 4, time: 4, data: { title: "Greeting" } },
  { type: "assistant/message", seq: 5, time: 5, data: { message: { role: "assistant", content: [{ type: "reasoning", text: "hmm" }, { type: "tool-call", id: "c1", name: "get", arguments: "{\"a\":1}" }], source: { kind: "model", provider: "p", model: "m", replayState: { response: { api: "openai-completions", stopReason: "toolUse" }, blocks: [{ thinkingSignature: "reasoning_content" }, {}] } } }, usage: { inputTokens: 7, outputTokens: 3 } } },
  { type: "tool/call", seq: 6, time: 6, data: { callId: "c1", name: "get", arguments: "{\"a\":1}" } },
  { type: "tool/result", seq: 7, time: 7, data: { message: { source: { callId: "c1" }, content: [{ type: "tool-result", toolCallId: "c1", content: [{ type: "text", text: "result!" }] }] } } },
  { type: "assistant/message", seq: 8, time: 8, data: { message: { role: "assistant", content: [{ type: "text", text: "done" }], source: { provider: "p", model: "m" } } } },
  { type: "turn/end", seq: 9, time: 9, data: { reason: { kind: "completed" } } },
);
const v4 = jsonl(
  { type: "session", version: 4, id: "s4", createdAt: 5 },
  { type: "turn/start", seq: 1, time: 1, data: { turn: 1 } },
  user(2, "q"),
  { type: "tool/call", seq: 3, time: 3, data: { callId: "c", name: "t", arguments: "{}" } },
  { type: "tool/result", seq: 4, time: 4, data: { message: { role: "tool", toolCallId: "c", isError: true, content: [{ type: "text", text: "bad" }] } } },
  { type: "turn/end", seq: 5, time: 5, data: { reason: { kind: "aborted" } } },
);

describe("importLegacyLog", () => {
  it("maps a v0 log: user text only, thinking signature, usage, wrapped tool result", () => {
    const out = importLegacyLog(v0)!;
    expect(out.header).toMatchObject({ id: "s0", cwd: "/w", title: "Greeting", origin: "legacy-import" });
    const msgs = historyFromRecords(out.records);
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant", "toolResult", "assistant"]);
    const a = msgs[1] as { content: unknown[]; usage: { input: number }; stopReason: string };
    expect(a.content).toEqual([{ type: "thinking", thinking: "hmm", thinkingSignature: "reasoning_content" }, { type: "toolCall", id: "c1", name: "get", arguments: { a: 1 } }]);
    expect(a.usage.input).toBe(7);
    expect(a.stopReason).toBe("toolUse");
    expect(msgs[2]).toMatchObject({ toolCallId: "c1", toolName: "get", isError: false, content: [{ text: "result!" }] });
    expect(foldState(out.records).lastEnd).toBe("stop");
  });

  it("maps a v4 log: role-tool results, errors and abort", () => {
    const out = importLegacyLog(v4)!;
    const msgs = historyFromRecords(out.records);
    expect(msgs.at(-1)).toMatchObject({ role: "toolResult", isError: true, content: [{ text: "bad" }] });
    expect(foldState(out.records).lastEnd).toBe("aborted");
  });

  it("rejects non-session input and tolerates garbage lines", () => {
    expect(importLegacyLog("{\"type\":\"turn/start\"}")).toBeUndefined();
    expect(importLegacyLog(`${v4}\nnot json`)!.report.skipped).toBe(1);
  });
});

describe("importLegacyTree", () => {
  it("imports zstd logs idempotently and never touches the source", async () => {
    const src = await mkdtemp(path.join(os.tmpdir(), "dsh-src-"));
    const dst = await mkdtemp(path.join(os.tmpdir(), "dsh-dst-"));
    await mkdir(path.join(src, "proj", "abc"), { recursive: true });
    await writeFile(path.join(src, "proj", "abc", "session.jsonl.zstd"), zstdCompressSync(Buffer.from(v0)));
    await writeFile(path.join(src, "proj", "abc", "session.lock"), "x");
    const first = await importLegacyTree(src, dst);
    expect(first.imported).toEqual(["abc"]);
    expect((await readSession(dst, "abc"))?.header.title).toBe("Greeting");
    const second = await importLegacyTree(src, dst);
    expect(second).toMatchObject({ imported: [], existing: ["abc"] });
    expect(await readdir(path.join(src, "proj", "abc"))).toHaveLength(2);
  });
});

describe("importLegacySession", () => {
  it("imports one session by id from any project folder, once", async () => {
    const src = await mkdtemp(path.join(os.tmpdir(), "dsh-one-src-"));
    const dst = await mkdtemp(path.join(os.tmpdir(), "dsh-one-dst-"));
    await mkdir(path.join(src, "projA", "other"), { recursive: true });
    await mkdir(path.join(src, "projB", "wanted"), { recursive: true });
    await writeFile(path.join(src, "projB", "wanted", "session.v4.jsonl.zstd"), zstdCompressSync(Buffer.from(v4)));
    expect(await importLegacySession(src, dst, "missing")).toBe(false);
    expect(await importLegacySession(src, dst, "wanted")).toBe(true);
    expect((await readSession(dst, "wanted"))?.header.id).toBe("wanted");
    expect(await importLegacySession(src, dst, "wanted")).toBe(false);
  });
});
