/**
 * Unit tests for the presentationMeta recomputation helpers: dsh does NOT
 * persist output.presentationMeta in the session log — the host recomputes it
 * from the registered tool definition (like dsh's own web shell). These cover
 * resolvePresentationMeta (happy path + tolerance) and enrichToolCallsWithMeta
 * (replay attachment).
 */
import { describe, it, expect, afterEach } from "vitest";
import { resolvePresentationMeta, enrichToolCallsWithMeta, __setToolDefForTest } from "./run-cordis-loop";

afterEach(() => __setToolDefForTest("viz", undefined));

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
});
