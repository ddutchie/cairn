import { describe, expect, it } from "vitest";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { StreamFn } from "./loop";
import { createModelReviewer } from "./reviewer";

const model = { maxTokens: 4096 } as Model<Api>;
const reply = (...texts: string[]) => {
  const prompts: string[] = [];
  const streamFn = ((_m: unknown, ctx: { messages: Array<{ content: string }> }) => {
    prompts.push(ctx.messages[0].content);
    const text = texts[Math.min(prompts.length - 1, texts.length - 1)];
    return { [Symbol.asyncIterator]: async function* () { /* no events */ }, result: async () => ({ stopReason: "stop", content: [{ type: "text", text }] }) };
  }) as unknown as StreamFn;
  return { streamFn, prompts };
};
const review = (streamFn: StreamFn, risk: { class: "EXEC" | "EXTERNAL"; command?: string }) =>
  createModelReviewer({ model, streamFn, cwd: "/p", userRequests: () => ["run the tests"] })({ sessionId: "s", callId: "c", tool: "bash", args: { command: risk.command }, risk: risk as never });

describe("createModelReviewer", () => {
  it("lets a clearly fine call through after one cheap pass", async () => {
    const r = reply('{"verdict":"allow","reason":"runs tests"}');
    expect(await review(r.streamFn, { class: "EXEC", command: "npm test" })).toMatchObject({ verdict: "allow", tags: ["stage1"] });
    expect(r.prompts).toHaveLength(1);
    expect(r.prompts[0]).toContain("run the tests");
    expect(r.prompts[0]).toContain("npm test");
  });
  it("confirms anything else in a second stage whose verdict stands", async () => {
    const r = reply('{"verdict":"ask","reason":"unsure"}', 'noise {"verdict":"block","reason":"rm -rf outside project"} noise');
    expect(await review(r.streamFn, { class: "EXEC", command: "rm -rf ~" })).toMatchObject({ verdict: "block", tags: ["stage2"] });
    expect(r.prompts).toHaveLength(2);
  });
  it("never sends external calls to the model", async () => {
    const r = reply('{"verdict":"allow","reason":"x"}');
    expect(await review(r.streamFn, { class: "EXTERNAL" })).toMatchObject({ verdict: "ask" });
    expect(r.prompts).toHaveLength(0);
  });
  it("throws on unparseable output so the loop falls back to asking", async () => {
    await expect(review(reply("nope").streamFn, { class: "EXEC", command: "ls" })).rejects.toThrow();
  });
});
