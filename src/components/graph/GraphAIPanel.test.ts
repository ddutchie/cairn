/**
 * Unit tests for GraphAIPanel pure helpers:
 *   - wikilinkAlreadyExists  — duplicate wikilink guard
 *   - buildGraphContext      — graph snapshot serialiser fed to the AI
 */

import { describe, it, expect } from "vitest";
import { wikilinkAlreadyExists, buildGraphContext } from "./graph-ai-utils";
import type { KnowledgeGraph, GraphNode } from "../../types";

// ── wikilinkAlreadyExists ─────────────────────────────────────────────────────

describe("wikilinkAlreadyExists", () => {
  it("returns false when the link is absent", () => {
    expect(wikilinkAlreadyExists("Some note content", "Target Note")).toBe(false);
  });

  it("returns true for an exact match", () => {
    expect(wikilinkAlreadyExists("See [[Target Note]] for details.", "Target Note")).toBe(true);
  });

  it("is case-insensitive on the title", () => {
    expect(wikilinkAlreadyExists("[[target note]]", "Target Note")).toBe(true);
    expect(wikilinkAlreadyExists("[[TARGET NOTE]]", "Target Note")).toBe(true);
  });

  it("ignores surrounding whitespace inside brackets", () => {
    expect(wikilinkAlreadyExists("[[ Target Note ]]", "Target Note")).toBe(true);
  });

  it("does not match partial title overlap", () => {
    expect(wikilinkAlreadyExists("[[Target Note Extended]]", "Target Note")).toBe(false);
  });

  it("handles regex special characters in the title", () => {
    expect(wikilinkAlreadyExists("[[C++ Notes]]", "C++ Notes")).toBe(true);
    expect(wikilinkAlreadyExists("plain text", "C++ Notes")).toBe(false);
  });

  it("returns true when the link appears anywhere in multi-line content", () => {
    const content = "Intro paragraph.\n\nSome detail.\n\n[[Target Note]]\n\nMore text.";
    expect(wikilinkAlreadyExists(content, "Target Note")).toBe(true);
  });

  it("returns false for empty content", () => {
    expect(wikilinkAlreadyExists("", "Target Note")).toBe(false);
  });
});

// ── buildGraphContext ─────────────────────────────────────────────────────────

function makeNote(id: string, title: string, snippet = ""): GraphNode {
  return { id, type: "note", title, workspaceId: "ws1", meta: { snippet } };
}

function makeEdge(source: string, target: string, type: string, weight?: number) {
  return { id: `${type}:${source}:${target}`, source, target, type, weight } as KnowledgeGraph["edges"][number];
}

describe("buildGraphContext", () => {
  it("includes all nodes in the NODES section", () => {
    const graph: KnowledgeGraph = {
      nodes: [makeNote("n1", "Alpha"), makeNote("n2", "Beta")],
      edges: [],
    };
    const ctx = buildGraphContext(graph, null);
    expect(ctx).toContain('"Alpha"');
    expect(ctx).toContain('"Beta"');
    expect(ctx).toContain("NODES (2 total");
  });

  it("puts wikilink edges in EXISTING WIKILINKS, not OTHER EDGES", () => {
    const graph: KnowledgeGraph = {
      nodes: [makeNote("n1", "Alpha"), makeNote("n2", "Beta")],
      edges: [makeEdge("n1", "n2", "wikilink", 1.0)],
    };
    const ctx = buildGraphContext(graph, null);
    expect(ctx).toContain("EXISTING WIKILINKS");
    expect(ctx).toContain('"Alpha" ↔ "Beta"');
    // The wikilink pair must NOT appear in the OTHER EDGES block
    const otherEdgesSection = ctx.split("OTHER EDGES")[1] ?? "";
    expect(otherEdgesSection).not.toContain('"Alpha"');
  });

  it("puts non-wikilink edges in OTHER EDGES", () => {
    const graph: KnowledgeGraph = {
      nodes: [makeNote("n1", "Alpha"), makeNote("n2", "Beta")],
      edges: [makeEdge("n1", "n2", "co-mention", 0.9)],
    };
    const ctx = buildGraphContext(graph, null);
    expect(ctx).toContain("OTHER EDGES");
    expect(ctx).toContain('"Alpha" → "Beta" (co-mention');
    // co-mention must NOT appear in EXISTING WIKILINKS
    const wikilinkSection = ctx.split("EXISTING WIKILINKS")[1]?.split("OTHER EDGES")[0] ?? "";
    expect(wikilinkSection).not.toContain("Alpha");
  });

  it("shows (none) in EXISTING WIKILINKS when there are no wikilink edges", () => {
    const graph: KnowledgeGraph = {
      nodes: [makeNote("n1", "Alpha")],
      edges: [],
    };
    const ctx = buildGraphContext(graph, null);
    // Should still have the section header, with (none)
    expect(ctx).toContain("EXISTING WIKILINKS");
    // The (none) placeholder should follow the wikilinks header
    const afterHeader = ctx.split("EXISTING WIKILINKS")[1] ?? "";
    expect(afterHeader.split("OTHER EDGES")[0]).toContain("(none)");
  });

  it("includes the do-not-suggest label in EXISTING WIKILINKS header", () => {
    const graph: KnowledgeGraph = { nodes: [], edges: [] };
    const ctx = buildGraphContext(graph, null);
    expect(ctx).toContain("do NOT suggest adding these");
  });

  it("includes selected node info when provided", () => {
    const graph: KnowledgeGraph = {
      nodes: [makeNote("n1", "Alpha", "Some snippet")],
      edges: [],
    };
    const ctx = buildGraphContext(graph, makeNote("n1", "Alpha", "Some snippet"));
    expect(ctx).toContain("Selected:");
    expect(ctx).toContain('"Alpha"');
  });

  it("omits selected node section when null", () => {
    const graph: KnowledgeGraph = { nodes: [], edges: [] };
    const ctx = buildGraphContext(graph, null);
    expect(ctx).not.toContain("Selected:");
  });

  it("includes both wikilink and other edges when mixed", () => {
    const graph: KnowledgeGraph = {
      nodes: [makeNote("n1", "Alpha"), makeNote("n2", "Beta"), makeNote("n3", "Gamma")],
      edges: [
        makeEdge("n1", "n2", "wikilink", 1.0),
        makeEdge("n2", "n3", "keyword", 0.4),
      ],
    };
    const ctx = buildGraphContext(graph, null);
    expect(ctx).toContain('"Alpha" ↔ "Beta"');
    expect(ctx).toContain('"Beta" → "Gamma" (keyword');
    // Cross-check: wikilink pair not in other edges block
    const otherEdgesSection = ctx.split("OTHER EDGES")[1] ?? "";
    expect(otherEdgesSection).not.toContain("Alpha");
  });
});
