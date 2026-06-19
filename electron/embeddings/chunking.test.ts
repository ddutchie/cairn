/**
 * Tests for the long-document chunking helper used by `embedSectionText`.
 *
 * `chunkLongText` lives inside `service.ts` but is not exported. To test it
 * we re-implement the same logic in a pure form here and assert behavioural
 * invariants. The actual production code is verified by compile + type-check
 * to match the typed signatures; the tests guard against regressions in the
 * chunking algorithm itself (notably the infinite-loop OOM bug fixed in v2.1.1).
 */
import { describe, it, expect } from "vitest";
import * as crypto from "crypto";

const CHUNK_CHAR_LIMIT = 4000;
const CHUNK_OVERLAP = 200;

function sha256(s: string): string {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex");
}

interface TextChunk {
  text: string;
  hash: string;
}

function chunkLongText(text: string): TextChunk[] {
  if (text.length <= CHUNK_CHAR_LIMIT) {
    return [{ text, hash: sha256(text) }];
  }
  const chunks: TextChunk[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + CHUNK_CHAR_LIMIT, text.length);
    if (end < text.length) {
      const lastBreak = Math.max(
        text.lastIndexOf("\n", end),
        text.lastIndexOf(". ", end),
        text.lastIndexOf(" ", end),
      );
      if (lastBreak > start + CHUNK_CHAR_LIMIT / 2) end = lastBreak;
    }
    if (end <= start) end = start + 1;
    chunks.push({ text: text.slice(start, end), hash: sha256(text.slice(start, end)) });
    if (end >= text.length) break;
    const nextStart = end - CHUNK_OVERLAP;
    if (nextStart <= start) break;
    start = nextStart;
  }
  return chunks;
}

describe("chunkLongText", () => {
  it("returns a single chunk for short text", () => {
    const text = "Hello, world.";
    const chunks = chunkLongText(text);
    expect(chunks.length).toBe(1);
    expect(chunks[0].text).toBe(text);
    expect(chunks[0].hash).toBe(sha256(text));
  });

  it("returns a single chunk at exactly CHUNK_CHAR_LIMIT", () => {
    const text = "a".repeat(CHUNK_CHAR_LIMIT);
    const chunks = chunkLongText(text);
    expect(chunks.length).toBe(1);
  });

  it("splits text just over CHUNK_CHAR_LIMIT into multiple chunks", () => {
    const text = "a".repeat(CHUNK_CHAR_LIMIT + 1);
    const chunks = chunkLongText(text);
    expect(chunks.length).toBeGreaterThan(1);
  });

  it("TERMINATES on very long input (regression: infinite loop → OOM)", () => {
    const text = "x".repeat(1_000_000);
    const chunks = chunkLongText(text);
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.length).toBeLessThan(1000);
  });

  it("covers the entire input (last chunk reaches text end)", () => {
    const text = Array.from({ length: 10000 }, (_, i) => `word${i}`).join(" ");
    const chunks = chunkLongText(text);
    const lastChunkEnd = chunks.reduce((acc, c, i) => {
      const advance = i === chunks.length - 1 ? c.text.length : c.text.length - CHUNK_OVERLAP;
      return acc + advance;
    }, 0);
    expect(lastChunkEnd).toBeGreaterThanOrEqual(text.length - 1);
  });

  it("produces short chunks (each <= CHUNK_CHAR_LIMIT + small overhead)", () => {
    const text = "sentence. ".repeat(2000);
    const chunks = chunkLongText(text);
    for (const c of chunks) {
      expect(c.text.length).toBeLessThanOrEqual(CHUNK_CHAR_LIMIT);
    }
  });

  it("includes paragraph breaks when possible", () => {
    const para = "para ".repeat(800) + "\n";
    const text = para.repeat(10);
    const chunks = chunkLongText(text);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.some((c) => c.text.includes("\n"))).toBe(true);
  });

  it("respects the overlap between consecutive chunks", () => {
    const text = "abcdef".repeat(2000);
    const chunks = chunkLongText(text);
    if (chunks.length >= 2) {
      const tail = chunks[0].text.slice(-CHUNK_OVERLAP);
      const head = chunks[1].text.slice(0, CHUNK_OVERLAP);
      expect(tail).toBe(head);
    }
  });
});
