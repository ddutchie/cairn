/**
 * Deterministic large knowledge graph for the graph canvas benchmark.
 *
 * Default size matches a real work workspace that felt slow: 476 nodes and
 * 2756 edges. The edge-type mix follows what `electron/db/graph-queries.ts`
 * emits (membership, links, and the cached keyword / co-mention / semantic
 * relations with weights), so the canvases take the same draw paths
 * (dashed vs solid strokes, per-weight widths) as on real data.
 *
 * Set GRAPH_JSON=/path/to/graph.json to benchmark a real graph instead (see
 * tests/perf/README.md for how to export one from the app).
 */

import * as fs from "fs";

type Node = { id: string; type: string; title: string; projectId?: string; workspaceId: string };
type Edge = { id: string; source: string; target: string; type: string; weight?: number };
export type BenchGraph = { nodes: Node[]; edges: Edge[] };

const WS_ID = "ws-cairn-hq";

/** Mulberry32: small seeded PRNG so every run builds the same graph. */
function rng(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = [
  "Roadmap", "Sync", "Offline", "Auth", "Search", "Index", "Billing", "Onboarding", "Design", "Tokens",
  "Release", "Retro", "Incident", "Metrics", "Hiring", "Budget", "Vendor", "Migration", "API", "Schema",
  "Mobile", "Desktop", "Graph", "Agent", "Review", "Plan", "Spec", "Notes", "Q3", "Q4",
];

export interface GraphShape {
  projects: number;
  notes: number;
  cards: number;
  tags: number;
  /** Edge counts per type, added on top of one project-member edge per note/card. */
  edges: Record<string, number>;
}

/** 476 nodes, 2756 edges. */
export const WORK_PC_SHAPE: GraphShape = {
  projects: 8,
  notes: 260,
  cards: 160,
  tags: 48,
  edges: {
    "tag-member": 760,
    "note-note": 260,
    "note-card": 160,
    wikilink: 150,
    keyword: 400,
    "co-mention": 200,
    semantic: 406,
  },
};

const WEIGHTED = new Set(["keyword", "co-mention", "semantic"]);

export function buildLargeGraph(shape: GraphShape = WORK_PC_SHAPE, seed = 42): BenchGraph {
  const rand = rng(seed);
  const pick = <T,>(arr: T[]) => arr[Math.floor(rand() * arr.length)];
  const title = () => `${pick(WORDS)} ${pick(WORDS)} ${Math.floor(rand() * 900 + 100)}`;

  const nodes: Node[] = [];
  const projects: string[] = [];
  for (let i = 0; i < shape.projects; i++) {
    const id = `proj-${i}`;
    projects.push(id);
    nodes.push({ id, type: "project", title: `${pick(WORDS)} Project ${i}`, workspaceId: WS_ID });
  }
  // Uneven project sizes, like real workspaces: a couple of big ones.
  const projectFor = () => projects[Math.min(projects.length - 1, Math.floor(Math.pow(rand(), 1.6) * projects.length))];
  const notes: Node[] = [];
  const cards: Node[] = [];
  for (let i = 0; i < shape.notes; i++) {
    const n = { id: `note-${i}`, type: "note", title: title(), projectId: projectFor(), workspaceId: WS_ID };
    notes.push(n); nodes.push(n);
  }
  for (let i = 0; i < shape.cards; i++) {
    const n = { id: `card-${i}`, type: "card", title: title(), projectId: projectFor(), workspaceId: WS_ID };
    cards.push(n); nodes.push(n);
  }
  const tags: Node[] = [];
  for (let i = 0; i < shape.tags; i++) {
    const n = { id: `tag-${i}`, type: "tag", title: `#${pick(WORDS).toLowerCase()}-${i}`, workspaceId: WS_ID };
    tags.push(n); nodes.push(n);
  }

  const edges: Edge[] = [];
  const seen = new Set<string>();
  const add = (type: string, source: string, target: string) => {
    if (source === target) return false;
    const key = `${type}:${source}:${target}`;
    if (seen.has(key)) return false;
    seen.add(key);
    const e: Edge = { id: `e-${edges.length}`, source, target, type };
    // Cached relations carry a 2-dp weight (graph-queries rounds them).
    if (WEIGHTED.has(type)) e.weight = Math.round((0.55 + rand() * 0.45) * 100) / 100;
    edges.push(e);
    return true;
  };

  for (const n of [...notes, ...cards]) add("project-member", n.projectId!, n.id);

  // Links mostly stay inside a project, which is what makes the clusters.
  const items = [...notes, ...cards];
  const sameProject = (a: Node, pool: Node[]) => {
    const local = pool.filter((p) => p.projectId === a.projectId);
    return rand() < 0.8 && local.length > 1 ? pick(local) : pick(pool);
  };
  const endpoints: Record<string, () => [string, string]> = {
    "tag-member": () => [pick(items).id, pick(tags).id],
    "note-note": () => { const a = pick(notes); return [a.id, sameProject(a, notes).id]; },
    "note-card": () => { const a = pick(notes); return [a.id, sameProject(a, cards).id]; },
    wikilink: () => { const a = pick(notes); return [a.id, sameProject(a, notes).id]; },
    keyword: () => { const a = pick(items); return [a.id, sameProject(a, items).id]; },
    "co-mention": () => { const a = pick(items); return [a.id, sameProject(a, items).id]; },
    semantic: () => { const a = pick(notes); return [a.id, sameProject(a, notes).id]; },
  };
  for (const [type, count] of Object.entries(shape.edges)) {
    const make = endpoints[type];
    if (!make) throw new Error(`no endpoint rule for edge type ${type}`);
    let made = 0, tries = 0;
    while (made < count && tries++ < count * 50) if (add(type, ...make())) made++;
    if (made < count) throw new Error(`could not generate ${count} "${type}" edges, only ${made}; the graph shape has too few distinct pairs`);
  }
  return { nodes, edges };
}

/** The graph to benchmark: GRAPH_JSON if set, otherwise the synthetic one. */
export function loadBenchGraph(): { graph: BenchGraph; source: string } {
  const file = process.env.GRAPH_JSON;
  if (file) {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<BenchGraph>;
    if (!Array.isArray(raw.nodes) || !Array.isArray(raw.edges)) {
      throw new Error(`${file}: expected { nodes: [], edges: [] }`);
    }
    // Put every node in the fixture workspace so the view shows it.
    const nodes = raw.nodes.map((n) => ({ ...n, workspaceId: WS_ID }));
    return { graph: { nodes, edges: raw.edges }, source: file };
  }
  return { graph: buildLargeGraph(), source: "synthetic (WORK_PC_SHAPE)" };
}
