import { fauxAssistantMessage, fauxToolCall, type Message, type ToolResultMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { applyCompaction, buildContextView, compactHistory, compactionThreshold, estimateTokens, isSummaryMessage, planCompaction, pruneImages, pruneToolResults, userContent } from "./context";
import type { AgentEvent } from "./events";
import { makeHarness } from "./test-harness";

const user = (text: string, timestamp = 1): Message => ({ role: "user", content: text, timestamp });
const result = (id: string, text: string): ToolResultMessage => ({ role: "toolResult", toolCallId: id, toolName: "t", content: [{ type: "text", text }], isError: false, timestamp: 1 });
const callMsg = (id: string) => fauxAssistantMessage([fauxToolCall("t", {}, { id })], { stopReason: "toolUse" });
const text = (m: Message) => (typeof m.content === "string" ? m.content : m.content.map((b) => ("text" in b ? b.text : "")).join(""));
const rec = (...events: AgentEvent[]) => events.map((event, i) => ({ event, time: i + 1 }));

describe("planCompaction", () => {
  it("never cuts between a tool call and its results", () => {
    const msgs = [user("a".repeat(400)), callMsg("c1"), result("c1", "r".repeat(400)), user("b".repeat(40)), fauxAssistantMessage("ok")];
    // keep ~1 message worth → naive cut lands on the tool result at index 2
    const plan = planCompaction(msgs, 100)!;
    expect(msgs[msgs.length - plan.keepCount].role).not.toBe("toolResult");
    expect(plan.head.length + plan.keepCount).toBe(msgs.length);
  });

  it("returns undefined when everything fits in the kept tail", () => {
    expect(planCompaction([user("hi")], 10_000)).toBeUndefined();
  });
});

describe("buildContextView", () => {
  const turn = (q: string): AgentEvent[] => [
    { type: "turn/start", sessionId: "s", profile: "p" },
    { type: "user/message", content: q },
    { type: "assistant/message", message: fauxAssistantMessage(`a:${q}`) },
    { type: "turn/end", reason: "stop" },
  ];

  it("replays a compaction: summary first, then the kept tail, then later turns", () => {
    const view = buildContextView(rec(...turn("one"), ...turn("two"), { type: "compaction", summary: "SUM", keepCount: 2, tokensBefore: 9, trigger: "manual" }, ...turn("three")));
    expect(view.map((m) => m.role)).toEqual(["user", "user", "assistant", "user", "assistant"]);
    expect(isSummaryMessage(view[0])).toBe(true);
    expect(view.slice(1).map(text)).toEqual(["two", "a:two", "three", "a:three"]);
  });

  it("matches what the live loop holds after applyCompaction", () => {
    const before = buildContextView(rec(...turn("one"), ...turn("two")));
    const c = { summary: "S", keepCount: 2 };
    const live = applyCompaction(before, c);
    const replay = buildContextView(rec(...turn("one"), ...turn("two"), { type: "compaction", ...c, tokensBefore: 0, trigger: "threshold" }));
    expect(replay.map(text)).toEqual(live.map(text));
  });
});

describe("pruneToolResults", () => {
  it("stubs old bulky outputs, keeps recent ones and does not mutate", () => {
    const big = "x".repeat(10_000);
    const msgs: Message[] = [user("q"), callMsg("c1"), result("c1", big), user("q2"), callMsg("c2"), result("c2", big)];
    const out = pruneToolResults(msgs, { protectTokens: 1_000, minChars: 2_000 });
    expect(text(out[2])).toMatch(/pruned: 10000 chars/);
    expect(text(out[5])).toBe(big);
    expect(text(msgs[2])).toBe(big);
  });
});

describe("compactionThreshold", () => {
  it("is 80% of the message budget", () => {
    expect(compactionThreshold(100_000, 20_000)).toBe(64_000);
    expect(compactionThreshold(1000, 2000)).toBeUndefined();
  });
});

describe("compactHistory", () => {
  it("summarizes the head with the model and keeps the tail", async () => {
    const h = makeHarness();
    h.faux.setResponses([fauxAssistantMessage("## Goal\nship it")]);
    const history: Message[] = [user("x".repeat(4000)), fauxAssistantMessage("y".repeat(4000)), user("recent"), fauxAssistantMessage("ok")];
    const model = h.faux.getModel();
    const out = (await compactHistory(history, "manual", { model, streamFn: h.opts().streamFn, keepRecentTokens: 10 }))!;
    expect(out.event).toMatchObject({ type: "compaction", summary: "## Goal\nship it", trigger: "manual" });
    expect(out.history.length).toBe(1 + out.event.keepCount);
    expect(isSummaryMessage(out.history[0])).toBe(true);
    expect(estimateTokens(out.history[0])).toBeGreaterThan(0);
  });

  it("throws on an empty summary so the loop can report it", async () => {
    const h = makeHarness();
    h.faux.setResponses([fauxAssistantMessage("")]);
    await expect(compactHistory([user("x".repeat(4000)), fauxAssistantMessage("y".repeat(4000)), user("z")], "manual", { model: h.faux.getModel(), streamFn: h.opts().streamFn, keepRecentTokens: 10 })).rejects.toThrow();
  });
});

describe("images", () => {
  const img = (data: string) => ({ mediaType: "image/png", data });
  const imageCount = (m: Message) => (typeof m.content === "string" ? 0 : m.content.filter((b) => b.type === "image").length);

  it("text alone stays a string; images make blocks", () => {
    expect(userContent("hi")).toBe("hi");
    expect(userContent("hi", [img("AAAA")])).toEqual([{ type: "text", text: "hi" }, { type: "image", data: "AAAA", mimeType: "image/png" }]);
  });

  it("rebuilds a user message with its images from the log", () => {
    const view = buildContextView([{ event: { type: "user/message", content: "see", images: [img("AAAA")] }, time: 1 }]);
    expect(imageCount(view[0])).toBe(1);
  });

  it("keeps only the newest images in the request, never touching the originals", () => {
    const history: Message[] = [1, 2, 3].map((n) => ({ role: "user", content: userContent(`m${n}`, [img(`I${n}`)]), timestamp: n }) as Message);
    const pruned = pruneImages(history, 2);
    expect(pruned.map(imageCount)).toEqual([0, 1, 1]);
    expect(JSON.stringify(pruned[0])).toContain("earlier image omitted");
    expect(history.map(imageCount)).toEqual([1, 1, 1]);
  });
});
