import { describe, it, expect } from "vitest";
import { normalizeNoteTitle } from "./host-shared/text-utils";
import { stripMarkdown } from "./host-shared/text-utils";

/**
 * Regression suite for the note-write pipeline.
 *
 * Covers the bugs identified in the proxy-team triage:
 *   1. ensure_note title matching was too strict, allowing near-duplicates.
 *
 * (The old SSE chunk-boundary cases left with electron/lib/sse.ts, deleted
 * with the legacy LLM transport in A2 — the engine consumes streams via
 * pi-ai now.)
 */

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
