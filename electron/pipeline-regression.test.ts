import { describe, it, expect } from "vitest";
import { iterSseData } from "./lib/sse";
import { normalizeNoteTitle } from "./shared/text-utils";
import { stripMarkdown } from "./shared/text-utils";

/**
 * Regression suite for the SSE → tool-arg → note-write pipeline.
 *
 * Covers the bugs identified in the proxy-team triage:
 *   1. SSE line-splitting drops records that straddle reader.read() chunks.
 *   2. JSON.parse of assembled tool args silently substituted args={}.
 *   3. ensure_note title matching was too strict, allowing near-duplicates.
 */

/** Builds a ReadableStream that emits the given string across N arbitrary chunk boundaries. */
function chunkedStream(payload: string, boundaries: number[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let pos = 0;
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pos >= payload.length) {
        controller.close();
        return;
      }
      const next = boundaries[i] ?? payload.length - pos;
      i += 1;
      const end = Math.min(pos + next, payload.length);
      controller.enqueue(enc.encode(payload.slice(pos, end)));
      pos = end;
    },
  });
}

const SSE_FRAMES = [
  'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n',
  'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_a","function":{"name":"ensure_note","arguments":"{\\"title\\":\\"I"}}]}}]}\n\n',
  'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"nterview Pipe"}}]}}]}\n\n',
  'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"line Tracker"}}]}}]}\n\n',
  'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\",\\"content\\":\\"x\\"}"}}]}}]}\n\n',
  "data: [DONE]\n\n",
].join("");

describe("iterSseData — chunk-boundary safety", () => {
  it("assembles fragmented SSE data frames split mid-record", async () => {
    // Split payload so most data: lines straddle chunk boundaries.
    const boundaries = [10, 7, 23, 15, 4, 50, 1, 80, 3, 33, 12, 9];
    const stream = chunkedStream(SSE_FRAMES, boundaries);
    const reader = stream.getReader();
    const payloads: string[] = [];
    for await (const p of iterSseData(reader)) payloads.push(p);

    // Should have 5 data frames + the [DONE] terminator (which returns early).
    expect(payloads).toHaveLength(5);
    const last = JSON.parse(payloads[4]);
    expect(last.choices[0].delta.tool_calls[0].function.arguments).toBe('","content":"x"}');

    // Reassemble the full tool-call arguments string across frames 1..4 and verify it parses.
    const argsJson = [1, 2, 3, 4]
      .map((i) => JSON.parse(payloads[i]).choices[0].delta.tool_calls[0].function.arguments)
      .join("");
    const parsed = JSON.parse(argsJson);
    expect(parsed.title).toBe("Interview Pipeline Tracker");
  });

  it("handles single-byte chunks and a final unterminated line", async () => {
    const payload = 'data: {"choices":[{"delta":{"content":"abc"}}]}\n\ndata: {"choices":[{"delta":{"content":"def"}}]}';
    const boundaries = [1, 1, 1, 1, 1, 1, 1, 1, 1, 1];
    const reader = chunkedStream(payload, boundaries).getReader();
    const payloads: string[] = [];
    for await (const p of iterSseData(reader)) payloads.push(p);
    expect(payloads).toHaveLength(2);
    const second = JSON.parse(payloads[1]);
    expect(second.choices[0].delta.content).toBe("def");
  });

  it("returns immediately when stream closes with no data lines", async () => {
    const stream = chunkedStream(": heartbeat\n\n", [3, 4, 2]);
    const reader = stream.getReader();
    const payloads: string[] = [];
    for await (const p of iterSseData(reader)) payloads.push(p);
    expect(payloads).toHaveLength(0);
  });
});

describe("normalizeNoteTitle — dedup predicate", () => {
  it("strips leading/trailing whitespace", () => {
    expect(normalizeNoteTitle("  Roadmap  ")).toBe("Roadmap");
  });

  it("collapses internal whitespace runs (spaces, tabs, newlines) to a single space", () => {
    expect(normalizeNoteTitle("Foo\n\t  Bar")).toBe("Foo Bar");
    expect(normalizeNoteTitle("Foo\tBar")).toBe("Foo Bar");
    expect(normalizeNoteTitle("Foo  Bar")).toBe("Foo Bar");
  });

  it("remains case-sensitive — Roadmap still differs from roadmap", () => {
    expect(normalizeNoteTitle("Roadmap")).not.toBe(normalizeNoteTitle("roadmap"));
  });

  it("treats non-string input as empty match key", () => {
    expect(normalizeNoteTitle(undefined as unknown as string)).toBe("");
    expect(normalizeNoteTitle(null as unknown as string)).toBe("");
  });

  it("satisfies the case-sensitivity expectation: two titles differing only by case MUST differ", () => {
    // Mirror the existing mcp-server.test.ts assertion at line ~1009.
    const a = normalizeNoteTitle("roadmap");
    const b = normalizeNoteTitle("Roadmap");
    expect(a).not.toBe(b);
  });

  it("matches near-duplicate whitespace variants so ensure_note would dedup them", () => {
    const existing = normalizeNoteTitle("Interview Pipeline Tracker");
    const incoming = normalizeNoteTitle("  Interview  Pipeline\tTracker  ");
    expect(incoming).toBe(existing);
  });
});

describe("stripMarkdown sanity (companion regression)", () => {
  it("still produces identical plaintext for unchanged input", () => {
    expect(stripMarkdown("# Heading\n\n**bold** text")).toBe("Heading\nbold text");
  });
});
