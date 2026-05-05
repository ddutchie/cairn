/**
 * Pure utility functions extracted from GraphAIPanel for testability.
 * No React, no store, no IPC — safe to import in Node/vitest.
 */

import type { KnowledgeGraph, GraphNode } from "../../types";

// ── Wikilink duplicate guard ──────────────────────────────────────────────────

/**
 * Returns true if `[[targetTitle]]` already exists in `content`
 * (exact title match, case-insensitive, surrounding whitespace ignored).
 */
export function wikilinkAlreadyExists(content: string, targetTitle: string): boolean {
  const escaped = targetTitle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\[\\[\\s*${escaped}\\s*\\]\\]`, "i").test(content);
}

// ── Graph context builder ─────────────────────────────────────────────────────

export function buildGraphContext(graph: KnowledgeGraph, selectedNode: GraphNode | null): string {
  const nodeLines = graph.nodes
    .slice(0, 80)
    .map((n) => {
      const snippet = n.meta?.snippet ? ` — "${n.meta.snippet.slice(0, 80).replace(/\n/g, " ")}"` : "";
      return `- [${n.type}] id=${n.id} "${n.title}"${snippet}`;
    })
    .join("\n");

  // Separate wikilink edges from other edges so the AI knows which [[links]] already exist
  const wikilinkEdges = graph.edges.filter((e) => e.type === "wikilink");
  const otherEdges    = graph.edges.filter((e) => e.type !== "wikilink");

  const edgeLines = otherEdges
    .slice(0, 100)
    .map((e) => {
      const src = graph.nodes.find((n) => n.id === e.source);
      const tgt = graph.nodes.find((n) => n.id === e.target);
      if (!src || !tgt) return null;
      return `- "${src.title}" → "${tgt.title}" (${e.type}${e.weight != null ? `, w=${e.weight.toFixed(2)}` : ""})`;
    })
    .filter(Boolean)
    .join("\n");

  const wikilinkLines = wikilinkEdges
    .slice(0, 60)
    .map((e) => {
      const src = graph.nodes.find((n) => n.id === e.source);
      const tgt = graph.nodes.find((n) => n.id === e.target);
      if (!src || !tgt) return null;
      return `- "${src.title}" ↔ "${tgt.title}"`;
    })
    .filter(Boolean)
    .join("\n");

  const sel = selectedNode
    ? `\n\nSelected: [${selectedNode.type}] id=${selectedNode.id} "${selectedNode.title}"${selectedNode.meta?.snippet ? `\nPreview: "${selectedNode.meta.snippet}"` : ""}`
    : "";

  return `NODES (${graph.nodes.length} total, first 80):\n${nodeLines || "(none)"}\n\nEXISTING WIKILINKS (${wikilinkEdges.length} total, first 60) — do NOT suggest adding these:\n${wikilinkLines || "(none)"}\n\nOTHER EDGES (${otherEdges.length} total, first 100):\n${edgeLines || "(none)"}${sel}`;
}
