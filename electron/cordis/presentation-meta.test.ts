/**
 * Unit tests for the presentationMeta recomputation helpers: dsh does NOT
 * persist output.presentationMeta in the session log — the host recomputes it
 * from the registered tool definition (like dsh's own web shell). These cover
 * resolvePresentationMeta (happy path + tolerance) and enrichToolCallsWithMeta
 * (replay attachment).
 */
import { describe, it, expect, afterEach } from "vitest";
import { resolvePresentationMeta, enrichToolCallsWithMeta, resolveToolCallView, resolveToolResultView, withToolCallView, withToolResultView, __setToolDefForTest } from "./run-cordis-loop";

afterEach(() => { __setToolDefForTest("viz", undefined); __setToolDefForTest("bash", undefined); });

describe("resolvePresentationMeta", () => {
  it("recomputes meta from the def's output.presentationMeta(args, value)", () => {
    __setToolDefForTest("viz", {
      output: { presentationMeta: (args: unknown, value: unknown) => ({ kind: "visualize", fragment: (value as { fragment?: string }).fragment, title: (args as { title?: string }).title }) },
    });
    const meta = resolvePresentationMeta("viz", JSON.stringify({ title: "T" }), JSON.stringify({ fragment: "<b>x</b>" }));
    expect(meta).toEqual({ kind: "visualize", fragment: "<b>x</b>", title: "T" });
  });

  it("returns undefined for unknown tools / missing hook / throwing hooks", () => {
    expect(resolvePresentationMeta("nope", "{}", "{}")).toBeUndefined();
    __setToolDefForTest("plain", { output: {} });
    expect(resolvePresentationMeta("plain", "{}", "{}")).toBeUndefined();
    __setToolDefForTest("boom", { output: { presentationMeta: () => { throw new Error("x"); } } });
    expect(resolvePresentationMeta("boom", "{}", "{}")).toBeUndefined();
  });
});

describe("enrichToolCallsWithMeta", () => {
  type Msg = { id: string; role: "assistant"; content: string; toolCalls?: Array<{ tool: string; args?: string; output?: string; meta?: unknown }> };
  it("attaches meta to replayed tool calls lacking it", () => {
    __setToolDefForTest("viz", {
      output: { presentationMeta: (_a: unknown, v: unknown) => ({ kind: "visualize", fragment: (v as { fragment?: string }).fragment }) },
    });
    const msgs: Msg[] = [{ id: "m1", role: "assistant", content: "", toolCalls: [{ tool: "viz", args: "{}", output: JSON.stringify({ fragment: "<i>hi</i>" }) }] }];
    const out = enrichToolCallsWithMeta(msgs);
    expect(out[0].toolCalls?.[0].meta).toEqual({ kind: "visualize", fragment: "<i>hi</i>" });
  });

  it("leaves calls without a registered def untouched", () => {
    const msgs: Msg[] = [{ id: "m2", role: "assistant", content: "", toolCalls: [{ tool: "unknown-tool", args: "{}", output: "y" }] }];
    enrichToolCallsWithMeta(msgs);
    expect(msgs[0].toolCalls?.[0].meta).toBeUndefined();
  });

  it("recomputes the tool-authored call view for replayed calls", () => {
    __setToolDefForTest("bash", {
      presentCall: (args: unknown) => ({ card: "terminal", title: (args as { command?: string }).command ?? "bash" }),
    });
    type VMsg = Msg & { toolCalls?: Array<{ tool: string; args?: string; output?: string; meta?: unknown; view?: unknown; resultView?: unknown }> };
    const msgs: VMsg[] = [{ id: "m3", role: "assistant", content: "", toolCalls: [{ tool: "bash", args: JSON.stringify({ command: "npm test" }) }] }];
    enrichToolCallsWithMeta(msgs);
    expect(msgs[0].toolCalls?.[0].view).toEqual({ card: "terminal", title: "npm test" });
  });

  it("recomputes the tool-authored result view for replayed calls", () => {
    __setToolDefForTest("bash", {
      presentResult: (_a: unknown, result: unknown) => {
        const r = result as { content?: Array<{ text?: string }> };
        return { card: "terminal", output: r.content?.[0]?.text ?? "", exitCode: 0 };
      },
    });
    type VMsg = Msg & { toolCalls?: Array<{ tool: string; args?: string; output?: string; meta?: unknown; view?: unknown; resultView?: unknown }> };
    const msgs: VMsg[] = [{ id: "m4", role: "assistant", content: "", toolCalls: [{ tool: "bash", args: "{}", output: "done" }] }];
    enrichToolCallsWithMeta(msgs);
    expect(msgs[0].toolCalls?.[0].resultView).toEqual({ card: "terminal", output: "done", exitCode: 0 });
  });
});

describe("resolveToolCallView", () => {
  it("returns the def's presentCall view when it carries a title", () => {
    __setToolDefForTest("bash", {
      presentCall: (args: unknown) => ({ card: "terminal", title: (args as { command?: string }).command ?? "bash" }),
    });
    expect(resolveToolCallView("bash", JSON.stringify({ command: "npm test" }))).toEqual({ card: "terminal", title: "npm test" });
  });

  it("returns undefined for unknown tools / missing or title-less views / throwing presenters", () => {
    expect(resolveToolCallView("nope", "{}")).toBeUndefined();
    __setToolDefForTest("plain", {});
    expect(resolveToolCallView("plain", "{}")).toBeUndefined();
    __setToolDefForTest("untitled", { presentCall: () => ({ card: "generic" }) });
    expect(resolveToolCallView("untitled", "{}")).toBeUndefined();
    __setToolDefForTest("boom", { presentCall: () => { throw new Error("x"); } });
    expect(resolveToolCallView("boom", "{}")).toBeUndefined();
    // Malformed args JSON degrades to {} rather than throwing.
    __setToolDefForTest("bash", { presentCall: (_args: unknown) => ({ card: "generic", title: "t" }) });
    expect(resolveToolCallView("bash", "{oops")).toEqual({ card: "generic", title: "t" });
  });
});

describe("withToolCallView", () => {
  it("attaches the view to tool/call events only", () => {
    __setToolDefForTest("bash", {
      presentCall: (args: unknown) => ({ card: "terminal", title: (args as { command?: string }).command ?? "bash" }),
    });
    const call = { type: "tool/call", data: { name: "bash", arguments: JSON.stringify({ command: "ls" }), callId: "c1" } };
    const out = withToolCallView(call);
    expect((out.data as { view?: unknown }).view).toEqual({ card: "terminal", title: "ls" });
    // Original event object untouched (log purity).
    expect((call.data as { view?: unknown }).view).toBeUndefined();

    const other = { type: "assistant/message", data: { a: 1 } };
    expect(withToolCallView(other)).toBe(other);
    // Unknown tool → unchanged.
    const unknown = { type: "tool/call", data: { name: "nope", arguments: "{}" } };
    expect(withToolCallView(unknown)).toBe(unknown);
  });
});

describe("resolveToolResultView", () => {
  const bashDef = {
    presentCall: (args: unknown) => ({ card: "terminal", title: (args as { command?: string }).command ?? "bash" }),
    presentResult: (args: unknown, result: unknown) => {
      const r = result as { content?: Array<{ type?: string; text?: string }>; isError?: boolean };
      const text = r.content?.[0]?.type === "text" ? (r.content[0].text ?? "") : "";
      return r.isError ? { card: "generic" as const, content: [{ type: "text", text }] } : { card: "terminal" as const, output: text, exitCode: 0 };
    },
  };
  it("synthesizes the ToolResult shape presenters read", () => {
    __setToolDefForTest("bash", bashDef);
    expect(resolveToolResultView("bash", JSON.stringify({ command: "ls" }), "x\n", false))
      .toEqual({ card: "terminal", output: "x\n", exitCode: 0 });
    expect(resolveToolResultView("bash", JSON.stringify({ command: "ls" }), "boom", true))
      .toEqual({ card: "generic", content: [{ type: "text", text: "boom" }] });
  });

  it("returns undefined for unknown tools / missing hook / card-less views / throwing presenters", () => {
    expect(resolveToolResultView("nope", "{}", "x")).toBeUndefined();
    __setToolDefForTest("plain", {});
    expect(resolveToolResultView("plain", "{}", "x")).toBeUndefined();
    __setToolDefForTest("cardless", { presentResult: () => ({ title: "t" }) });
    expect(resolveToolResultView("cardless", "{}", "x")).toBeUndefined();
    __setToolDefForTest("boom", { presentResult: () => { throw new Error("x"); } });
    expect(resolveToolResultView("boom", "{}", "x")).toBeUndefined();
  });
});

describe("withToolResultView", () => {
  it("bridges tool/call → tool/result via callId and attaches the view", () => {
    __setToolDefForTest("bash", {
      presentResult: (_a: unknown, result: unknown) => {
        const r = result as { content?: Array<{ text?: string }> };
        return { card: "terminal", output: r.content?.[0]?.text ?? "", exitCode: 0 };
      },
    });
    withToolCallView({ type: "tool/call", data: { name: "bash", arguments: JSON.stringify({ command: "ls" }), callId: "c9" } });
    const result = {
      type: "tool/result",
      data: { message: { source: { callId: "c9" }, content: [{ content: [{ type: "text", text: "hi" }] }] } },
    };
    const out = withToolResultView(result);
    expect((out.data as { resultView?: unknown }).resultView).toEqual({ card: "terminal", output: "hi", exitCode: 0 });
    // Original untouched; unknown callIds pass through.
    expect((result.data as { resultView?: unknown }).resultView).toBeUndefined();
    expect(withToolResultView({ type: "tool/result", data: { message: { source: { callId: "ghost" }, content: [] } } }).data).toEqual(
      { message: { source: { callId: "ghost" }, content: [] } },
    );
    expect(withToolResultView({ type: "assistant/message", data: {} })).toEqual({ type: "assistant/message", data: {} });
  });
});
