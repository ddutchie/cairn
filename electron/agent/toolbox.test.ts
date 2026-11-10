import { fauxAssistantMessage, fauxToolCall, getCurrentTools, Type } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { buildContextView } from "./context";
import type { AgentEvent } from "./events";
import { runTurn } from "./loop";
import { foldToolGroups } from "./session/history";
import { drive, makeHarness, ofType } from "./test-harness";
import { ENABLE_TOOLS, Toolbox } from "./toolbox";
import { defineTool, type AgentTool } from "./tools";

const tool = (name: string, ran?: string[]): AgentTool => defineTool({
  name, description: name, parameters: Type.Object({}), risk: () => ({ class: "READ" }),
  execute: async () => { ran?.push(name); return { content: `${name} ran` }; },
});
const names = (tools: readonly AgentTool[]) => tools.map((t) => t.name);
const ctx = { sessionId: "s1", callId: "c", workspaceRoot: "/ws" };

describe("Toolbox", () => {
  const box = (enabled?: string[], onEnable?: (g: string) => void) => new Toolbox({
    base: [tool("note")],
    groups: [{ id: "code", summary: "files", tools: [tool("read"), tool("bash")] }, { id: "extended", summary: "extras", tools: [tool("lsp")] }, { id: "empty", summary: "nothing", tools: [] }],
    tail: [tool("mcp__x__y")],
    enabled, onEnable,
  });

  it("only grows, in enable order, with connector tools last", async () => {
    const b = box();
    expect(names(b.current())).toEqual(["note", ENABLE_TOOLS, "mcp__x__y"]);
    const enable = b.current().find((t) => t.name === ENABLE_TOOLS)!;
    await enable.execute({ group: "extended" }, ctx);
    await enable.execute({ group: "code" }, ctx);
    expect(names(b.current())).toEqual(["note", ENABLE_TOOLS, "lsp", "read", "bash", "mcp__x__y"]);
  });

  it("keeps the enable tool's definition the same whatever is on", async () => {
    const b = box();
    const before = b.current().find((t) => t.name === ENABLE_TOOLS)!.description;
    await b.current().find((t) => t.name === ENABLE_TOOLS)!.execute({ group: "code" }, ctx);
    expect(b.current().find((t) => t.name === ENABLE_TOOLS)!.description).toBe(before);
    expect(before).toContain("code: files (read, bash)");
    expect(before).not.toContain("empty");
  });

  it("reports a group once, and refuses unknown ones", async () => {
    const logged: string[] = [];
    const b = box([], (g) => { logged.push(g); });
    const enable = b.current().find((t) => t.name === ENABLE_TOOLS)!;
    expect((await enable.execute({ group: "code" }, ctx)).isError).toBeFalsy();
    expect((await enable.execute({ group: "code" }, ctx)).content).toContain("already on");
    expect((await enable.execute({ group: "nope" }, ctx)).isError).toBe(true);
    expect(logged).toEqual(["code"]);
  });

  it("restores the logged order when a session is reopened", () => {
    const records = (["extended", "code", "extended"] as const).map((group, i) => ({ seq: i, time: i, event: { type: "tools/enabled", group } as AgentEvent }));
    expect(foldToolGroups(records)).toEqual(["extended", "code"]);
    expect(names(box(foldToolGroups(records)).current())).toEqual(["note", ENABLE_TOOLS, "lsp", "read", "bash", "mcp__x__y"]);
  });
});

describe("staged tools in a turn", () => {
  it("loads a group when one of its tools is called, and offers it from the next step", async () => {
    const ran: string[] = [];
    const toolbox = new Toolbox({ base: [tool("note", ran)], groups: [{ id: "code", summary: "files", tools: [tool("read", ran)] }] });
    const h = makeHarness();
    const offered: string[][] = [];
    const reply = (message: ReturnType<typeof fauxAssistantMessage>) => (c: unknown) => { offered.push(getCurrentTools((c as { messages: Parameters<typeof getCurrentTools>[0] }).messages).map((t) => t.name)); return message; };
    h.faux.setResponses([
      // Not loaded yet: the call is not run, but it loads the group.
      reply(fauxAssistantMessage([fauxToolCall("read", {}, { id: "c0" })], { stopReason: "toolUse" })),
      reply(fauxAssistantMessage([fauxToolCall(ENABLE_TOOLS, { group: "code" }, { id: "c1" })], { stopReason: "toolUse" })),
      reply(fauxAssistantMessage([fauxToolCall("read", {}, { id: "c2" })], { stopReason: "toolUse" })),
      reply(fauxAssistantMessage("done")),
    ]);
    const events = await drive(runTurn(h.opts({ tools: toolbox })));
    // The first call loaded the group by itself, so the explicit enable finds it already on.
    expect(offered).toEqual([["note", ENABLE_TOOLS], ["note", ENABLE_TOOLS, "read"], ["note", ENABLE_TOOLS, "read"], ["note", ENABLE_TOOLS, "read"]]);
    const results = ofType(events, "tool/result");
    expect(results.map((r) => [r.callId, r.isError])).toEqual([["c0", true], ["c1", false], ["c2", false]]);
    expect(results[0].text).toMatch(/not loaded.*call read again/);
    expect(results[1].text).toMatch(/already on/);
    expect(ran).toEqual(["read"]);
    // A name that belongs to no group is still unknown.
    h.faux.setResponses([reply(fauxAssistantMessage([fauxToolCall("nope", {}, { id: "c3" })], { stopReason: "toolUse" })), reply(fauxAssistantMessage("ok"))]);
    const more = await drive(runTurn(h.opts({ tools: toolbox })));
    expect(ofType(more, "tool/result")[0].text).toBe("Unknown tool: nope");
  });
});

describe("loop bookkeeping", () => {
  it("logs a Stop hook's follow-up so a replayed history matches the live one", async () => {
    const h = makeHarness();
    h.faux.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);
    let asked = false;
    const events = await drive(runTurn(h.opts({ hooks: { stop: async () => (asked ? {} : ((asked = true), { continueWith: "run the tests" })) } })));
    const users = ofType(events, "user/message");
    expect(users[1]).toMatchObject({ content: "continue: run the tests", synthetic: true });
    const text = (m: { content: unknown }) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content));
    const replay = buildContextView(events.filter((e) => e.type !== "assistant/delta").map((event, i) => ({ event, time: i })));
    expect(replay.map((m) => m.role)).toEqual(h.history.map((m) => m.role));
    expect(text(replay[2])).toBe(text(h.history[2]));
  });

  it("says so when a reply is cut off at the output limit", async () => {
    const h = makeHarness();
    h.faux.setResponses([fauxAssistantMessage("half a sent", { stopReason: "length" })]);
    const events = await drive(runTurn(h.opts()));
    expect(ofType(events, "error")[0].message).toMatch(/cut off/);
    expect(ofType(events, "turn/end")[0].reason).toBe("stop");
  });
});
