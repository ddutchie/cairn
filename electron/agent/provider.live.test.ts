/**
 * Live check of the new engine against a real OpenAI-compatible endpoint.
 * Opt-in: CAIRN_LIVE_TESTS=1. Defaults to the local bridge on :3042 (no key),
 * whose "claude-sonnet-4-5" route is really gpt-oss — report results as such.
 *
 *   CAIRN_LIVE_TESTS=1 npx vitest run electron/agent/provider.live.test.ts
 *   AGENT_LIVE_BASE_URL / AGENT_LIVE_MODEL / AGENT_LIVE_API_KEY override.
 */
import { Type } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { endpointUp, LIVE_TESTS_ENABLED } from "../lib/bench-endpoint";
import { Gate } from "./gate";
import { runTurn } from "./loop";
import { createRouteStream } from "./provider";
import { createRuleStore, presetRules } from "./rules";
import { defineTool } from "./tools";
import { drive, ofType, toolResults, types } from "./test-harness";
import type { Message } from "@earendil-works/pi-ai";

const BASE = process.env.AGENT_LIVE_BASE_URL ?? "http://localhost:3042/v1";
const MODEL = process.env.AGENT_LIVE_MODEL ?? "claude-sonnet-4-5";
const KEY = process.env.AGENT_LIVE_API_KEY ?? "";

const up = LIVE_TESTS_ENABLED && (await endpointUp(BASE, KEY));

describe.skipIf(!up)(`live: ${MODEL} @ ${BASE}`, () => {
  const { model, streamFn } = createRouteStream({ baseUrl: BASE, model: MODEL, apiKey: KEY, api: "openai-completions", maxTokens: 2048 });
  const executed: string[] = [];
  const tools = [
    defineTool({
      name: "get_secret_number", description: "Returns the secret number. Call this to learn it; do not guess.",
      parameters: Type.Object({}), risk: () => ({ class: "READ" }),
      execute: async () => { executed.push("get_secret_number"); return { content: "The secret number is 7421." }; },
    }),
    defineTool({
      name: "save_note", description: "Save a note with the given title.",
      parameters: Type.Object({ title: Type.String({ description: "Note title" }) }),
      risk: () => ({ class: "WRITE_CAIRN" }),
      execute: async (args) => { executed.push(`save_note:${args.title}`); return { content: "saved" }; },
    }),
  ];
  const base = (history: Message[], input: string, rules = createRuleStore()) => ({
    sessionId: "live", model, streamFn, history, input, tools, workspaceRoot: "/ws",
    profile: { id: "live", interactive: false, mode: "ask" as const }, rules, gate: new Gate(),
    systemPrompt: "You are a terse assistant. Use tools when asked. Never invent tool results.",
  });

  it("streams a plain answer", async () => {
    const history: Message[] = [];
    const events = await drive(runTurn(base(history, "Reply with exactly the word: pong")));
    expect(events.at(-1)).toEqual({ type: "turn/end", reason: "stop" });
    const text = ofType(events, "assistant/delta").map((e) => e.text).join("").toLowerCase();
    expect(text).toContain("pong");
    const msg = history.at(-1);
    expect(msg?.role === "assistant" && msg.usage.output).toBeGreaterThan(0);
  }, 90_000);

  it("calls a READ tool, feeds the result back and uses it", async () => {
    executed.length = 0;
    const history: Message[] = [];
    const events = await drive(runTurn(base(history, "Use the get_secret_number tool, then tell me the number.")));
    expect(executed).toContain("get_secret_number");
    expect(ofType(events, "tool/result")[0]).toMatchObject({ isError: false });
    const answer = ofType(events, "assistant/message").at(-1)?.message.content.map((b) => (b.type === "text" ? b.text : "")).join("");
    expect(answer).toContain("7421");
    expect(events.at(-1)).toEqual({ type: "turn/end", reason: "stop" });
  }, 120_000);

  it("denies an unapproved write headlessly, and allows it with the cairn-data preset", async () => {
    executed.length = 0;
    const denied = await drive(runTurn(base([], "Save a note titled 'Alpha' using the save_note tool.")));
    expect(types(denied)).toContain("approval/decided");
    expect(ofType(denied, "approval/decided")[0]).toMatchObject({ approved: false, by: "headless" });
    expect(executed).toHaveLength(0);

    const history: Message[] = [];
    const allowed = await drive(runTurn(base(history, "Save a note titled 'Alpha' using the save_note tool.", createRuleStore(presetRules("cairn-data")))));
    expect(executed.some((e) => e.startsWith("save_note"))).toBe(true);
    expect(toolResults(history)[0].isError).toBe(false);
    expect(allowed.at(-1)).toEqual({ type: "turn/end", reason: "stop" });
  }, 180_000);
});
