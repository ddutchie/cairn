"use client";

/**
 * ModuleMap — the default Architecture overview. A zoomable, directory-based
 * "module map": each top-level folder (module) is an SVG card sized by its
 * symbol count, with aggregated dependency arrows between modules (thicker =
 * more references; red = a mutual/cyclic dependency). Click a module to drill
 * in — the map re-scopes to that folder and shows its subfolders — with a
 * breadcrumb to climb back out.
 *
 * Unlike the file force-graph, this only ever renders a handful of nodes per
 * level, so it reads as an architecture diagram rather than a hairball. Laid
 * out with a one-shot d3-force pass (static — no animation loop) and drawn as
 * crisp SVG.
 *
 * Grouping is directory-based today; the query (getCodebaseModuleGraph) keeps a
 * pluggable seam for a future import-clustering strategy.
 */

import { useEffect, useMemo, useState } from "react";
import * as d3 from "d3";
import { ChevronRight, RefreshCw, Home, Sparkles } from "lucide-react";
import { useFontScale } from "../graph/analyticsHooks";
import { useCairnStore } from "@/store";
import { useShallow } from "zustand/react/shallow";

interface ModuleNode {
  id: string;
  label: string;
  fileCount: number;
  symbolCount: number;
  internalRefs: number;
}
interface ModuleEdge {
  source: string;
  target: string;
  weight: number;
}
interface ModuleGraph {
  folder: string;
  depth: number;
  grouping: "directory";
  nodes: ModuleNode[];
  edges: ModuleEdge[];
}

interface Props {
  /** The code directory root. */
  cwd: string;
}

type Positioned = ModuleNode & { x: number; y: number; r: number };

const W = 900;
const H = 620;

/** Node radius from symbol count (sub-linear, clamped). */
function radiusFor(symbolCount: number, maxSymbols: number): number {
  const t = maxSymbols > 0 ? symbolCount / maxSymbols : 0;
  return 26 + Math.sqrt(t) * 40; // 26–66px
}

/** A stable-ish colour per module from its id (so sibling modules differ). */
const MODULE_HUES = [265, 200, 150, 30, 340, 95, 220, 12, 300, 175];
function moduleColor(id: string, index: number): string {
  void id;
  const hue = MODULE_HUES[index % MODULE_HUES.length];
  return `hsl(${hue} 70% 60%)`;
}

export function ModuleMap({ cwd }: Props) {
  // NOTE: intentionally outside the analytics-canvas convention (useContainerDims
  // + useScopedData). This is an SVG with a fixed viewBox that self-scales via
  // preserveAspectRatio, so it needs no measured pixel dims; and its data is the
  // codebase module graph (fetched here), not the knowledge-graph nodes that
  // useScopedData derives. Only useFontScale applies — SVG font sizes must scale
  // with the app font-size setting.
  const fs = useFontScale();
  // Breadcrumb of folders we've drilled into (absolute paths). [] = root (cwd).
  const [path, setPath] = useState<string[]>([]);
  const [graph, setGraph] = useState<ModuleGraph | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);

  const agentConfig = useCairnStore(useShallow((s) => s.agentConfig));
  const [aiExplain, setAiExplain] = useState<{ overview: string; modules: string } | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);

  const scope = path.length ? path[path.length - 1] : cwd;

  // Reset any AI explanation when we navigate to a different scope.
  // eslint-disable-next-line react-hooks/set-state-in-effect -- clear stale AI explanation when the scoped folder changes
  useEffect(() => { setAiExplain(null); setAiError(null); }, [scope]);

  useEffect(() => {
    if (!cwd) return;
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch the module graph when the scoped folder changes
    setLoading(true);
    setError(null);
    window.electron?.agent
      .codebaseModuleGraph(scope, 1)
      .then((data) => { if (!cancelled && data) setGraph(data); })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [scope, cwd]);

  // Layout: connected modules get a force layout in the main area; modules with
  // no dependency edges (docs, .github, changelogs…) are parked in a tidy row
  // along the bottom instead of being flung to the corners by charge repulsion.
  const { positioned, isolated } = useMemo<{ positioned: Positioned[]; isolated: Positioned[] }>(() => {
    if (!graph || graph.nodes.length === 0) return { positioned: [], isolated: [] };
    const maxSym = Math.max(1, ...graph.nodes.map((n) => n.symbolCount));

    const connectedIds = new Set<string>();
    for (const e of graph.edges) { if (e.source !== e.target) { connectedIds.add(e.source); connectedIds.add(e.target); } }

    const connectedNodes = graph.nodes.filter((n) => connectedIds.has(n.id));
    const isolatedNodes = graph.nodes.filter((n) => !connectedIds.has(n.id));

    // ── connected: force layout in the upper ~75% of the canvas ──
    const layoutH = isolatedNodes.length ? H - 90 : H;
    const count = Math.max(1, connectedNodes.length);
    const sim = connectedNodes.map((n, i) => {
      const ang = (i / count) * Math.PI * 2;
      return {
        ...n,
        r: radiusFor(n.symbolCount, maxSym),
        x: W / 2 + Math.cos(ang) * 200,
        y: layoutH / 2 + Math.sin(ang) * 150,
      };
    }) as (Positioned & d3.SimulationNodeDatum)[];
    const links = graph.edges
      .filter((e) => e.source !== e.target && connectedIds.has(e.source) && connectedIds.has(e.target))
      .map((e) => ({ source: e.source, target: e.target }));
    d3.forceSimulation(sim)
      .force("charge", d3.forceManyBody<Positioned>().strength((d) => -18 * d.r))
      .force("link", d3.forceLink(links).id((d: d3.SimulationNodeDatum) => (d as Positioned).id).distance(150).strength(0.35))
      .force("x", d3.forceX(W / 2).strength(0.06))
      .force("y", d3.forceY(layoutH / 2).strength(0.08))
      .force("collide", d3.forceCollide<Positioned>().radius((d) => d.r + 14).iterations(4))
      .stop()
      .tick(400);

    // Recentre the connected cluster in the layout area (force drifts off-centre).
    if (sim.length) {
      const minX = Math.min(...sim.map((n) => n.x! - n.r));
      const maxX = Math.max(...sim.map((n) => n.x! + n.r));
      const minY = Math.min(...sim.map((n) => n.y! - n.r));
      const maxY = Math.max(...sim.map((n) => n.y! + n.r));
      const dx = (W - (minX + maxX)) / 2;
      const dy = (layoutH - (minY + maxY)) / 2;
      for (const n of sim) { n.x = (n.x ?? 0) + dx; n.y = (n.y ?? 0) + dy; }
    }
    for (const n of sim) {
      n.x = Math.max(n.r + 8, Math.min(W - n.r - 8, n.x ?? W / 2));
      n.y = Math.max(n.r + 8, Math.min(layoutH - n.r - 8, n.y ?? layoutH / 2));
    }

    // ── isolated: even row along the bottom (small fixed radius) ──
    const iso = isolatedNodes.map((n, i) => {
      const gap = W / (isolatedNodes.length + 1);
      return { ...n, r: 24, x: gap * (i + 1), y: H - 44 };
    }) as Positioned[];

    return { positioned: sim as Positioned[], isolated: iso };
  }, [graph]);

  const posById = useMemo(() => {
    const m = new Map<string, Positioned>();
    for (const p of positioned) m.set(p.id, p);
    for (const p of isolated) m.set(p.id, p);
    return m;
  }, [positioned, isolated]);

  // Detect mutual (cyclic) module pairs.
  const mutual = useMemo(() => {
    const set = new Set<string>();
    if (!graph) return set;
    const has = new Set(graph.edges.map((e) => `${e.source}\u0000${e.target}`));
    for (const e of graph.edges) {
      if (has.has(`${e.target}\u0000${e.source}`)) set.add(`${e.source}\u0000${e.target}`);
    }
    return set;
  }, [graph]);

  const maxWeight = useMemo(() => Math.max(1, ...(graph?.edges.map((e) => e.weight) ?? [1])), [graph]);

  // ── Heuristic one-line summary (always shown, no LLM) ──
  const heuristicSummary = useMemo(() => {
    if (!graph || graph.nodes.length === 0) return null;
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    const top = [...graph.nodes].sort((a, b) => b.symbolCount - a.symbolCount).slice(0, 3);
    // biggest dependency edges
    const bigEdges = [...graph.edges]
      .filter((e) => e.source !== e.target)
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 2)
      .map((e) => `${e.source} → ${e.target}`);
    const parts: string[] = [];
    if (top.length) parts.push(`Largest: ${top.map((t) => `${t.id} (${t.symbolCount} sym)`).join(", ")}`);
    if (bigEdges.length) parts.push(`Main dependencies: ${bigEdges.join(", ")}`);
    void byId;
    return parts.join(" · ");
  }, [graph]);

  // Compact text description of the module graph, sent to the LLM on demand.
  const llmSummary = useMemo(() => {
    if (!graph) return "";
    const nodeLines = graph.nodes
      .map((n) => `- ${n.id}: ${n.fileCount} files, ${n.symbolCount} symbols`)
      .join("\n");
    const edgeLines = graph.edges
      .filter((e) => e.source !== e.target)
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 40)
      .map((e) => `- ${e.source} depends on ${e.target} (${e.weight} refs)`)
      .join("\n");
    const rootName = scope.split(/[/\\]/).pop() || scope;
    return `Project/folder: ${rootName}\n\nModules:\n${nodeLines}\n\nDependencies:\n${edgeLines || "(none)"}`;
  }, [graph, scope]);

  const explainWithAI = async () => {
    if (aiLoading || !llmSummary) return;
    setAiLoading(true);
    setAiError(null);
    try {
      const config = { baseUrl: agentConfig.baseUrl, model: agentConfig.model, apiKey: agentConfig.apiKey };
      const res = await window.electron?.ai.explainArchitecture({ summary: llmSummary, config });
      if (res) setAiExplain(res);
    } catch (e) {
      setAiError(e instanceof Error ? e.message : String(e));
    } finally {
      setAiLoading(false);
    }
  };

  const drillInto = (mod: ModuleNode) => {
    if (mod.fileCount <= 1) return; // nothing to expand
    // Resolve the module's absolute folder path and push it.
    const abs = scope.replace(/[/\\]$/, "") + "/" + mod.id;
    setPath((p) => [...p, abs]);
    setGraph(null);
  };

  const crumbs = useMemo(() => {
    const rootName = cwd.split(/[/\\]/).pop() || cwd;
    const items = [{ label: rootName, index: -1 }];
    path.forEach((abs, i) => {
      const label = abs.slice(scope.length).replace(/^[/\\]/, "") || abs.split(/[/\\]/).pop() || abs;
      // label relative to the previous crumb
      const prev = i === 0 ? cwd : path[i - 1];
      const rel = abs.slice(prev.length).replace(/^[/\\]/, "");
      items.push({ label: rel || label, index: i });
    });
    return items;
  }, [path, cwd, scope]);

  return (
    <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
      {/* Breadcrumb */}
      <div className="flex items-center gap-1 px-3 py-1.5 border-b border-[var(--border)] flex-shrink-0 text-xs text-[var(--text-secondary)] overflow-x-auto">
        {crumbs.map((c, i) => (
          <span key={i} className="flex items-center gap-1 flex-shrink-0">
            {i > 0 && <ChevronRight size={12} className="text-[var(--text-tertiary)]" />}
            <button
              onClick={() => setPath((p) => (c.index < 0 ? [] : p.slice(0, c.index + 1)))}
              className={`flex items-center gap-1 hover:text-[var(--text-primary)] transition-colors ${
                i === crumbs.length - 1 ? "text-[var(--text-primary)] font-medium" : ""
              }`}
            >
              {i === 0 && <Home size={12} />}
              {c.label}
            </button>
          </span>
        ))}
        {loading && <RefreshCw size={12} className="animate-spin ml-2 text-[var(--text-tertiary)]" />}
      </div>

      {/* Summary header — heuristic by default, replaced by the AI explanation. */}
      {graph && graph.nodes.length > 0 && (
        <div className="px-3 py-2 border-b border-[var(--border)] flex-shrink-0 bg-[var(--surface-2)]">
          {aiExplain ? (
            <div className="flex flex-col gap-1.5">
              <div className="text-xs text-[var(--text-secondary)] leading-relaxed">{aiExplain.overview}</div>
              {aiExplain.modules && (
                <div className="text-[0.7rem] text-[var(--text-tertiary)] font-mono whitespace-pre-wrap leading-relaxed">
                  {aiExplain.modules}
                </div>
              )}
            </div>
          ) : (
            <div className="flex items-center gap-3">
              <div className="text-[0.7rem] text-[var(--text-tertiary)] flex-1 min-w-0 truncate">
                {heuristicSummary}
              </div>
              <button
                onClick={explainWithAI}
                disabled={aiLoading}
                className="flex items-center gap-1 px-2 py-1 rounded-md text-[0.7rem] font-semibold text-[var(--accent)] hover:bg-[color-mix(in_srgb,var(--accent)_12%,transparent)] transition-colors flex-shrink-0 disabled:opacity-60"
                title="Summarise this architecture with AI"
              >
                <Sparkles size={12} className={aiLoading ? "animate-pulse" : ""} />
                {aiLoading ? "Explaining…" : "Explain with AI"}
              </button>
            </div>
          )}
          {aiError && <div className="text-[0.7rem] text-[var(--danger)] mt-1">{aiError}</div>}
        </div>
      )}

      {error && (
        <div className="px-3 py-2 text-xs text-[var(--danger)] border-b border-[var(--border)]">{error}</div>
      )}

      <div className="flex-1 min-h-0 overflow-hidden flex items-center justify-center p-2">
        {!loading && graph && graph.nodes.length === 0 ? (
          <div className="text-xs text-[var(--text-tertiary)] text-center">
            No submodules here. This part of the tree is a leaf.
          </div>
        ) : (
          <svg
            viewBox={`0 0 ${W} ${H}`}
            className="w-full h-full max-w-full max-h-full"
            preserveAspectRatio="xMidYMid meet"
          >
            <defs>
              <marker id="mm-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" markerUnits="userSpaceOnUse" orient="auto-start-reverse">
                <path d="M0,1 L9,5 L0,9" fill="none" stroke="var(--text-secondary)" strokeWidth="1.6" />
              </marker>
              <marker id="mm-arrow-cycle" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" markerUnits="userSpaceOnUse" orient="auto-start-reverse">
                <path d="M0,1 L9,5 L0,9" fill="none" stroke="var(--danger)" strokeWidth="1.6" />
              </marker>
            </defs>

            {/* edges — thin, curved, subtle; width scales gently with weight */}
            {graph?.edges.map((e, i) => {
              const s = posById.get(e.source), t = posById.get(e.target);
              if (!s || !t || s === t) return null;
              const isCycle = mutual.has(`${e.source}\u0000${e.target}`);
              const dx = t.x - s.x, dy = t.y - s.y;
              const dist = Math.hypot(dx, dy) || 1;
              const ux = dx / dist, uy = dy / dist;
              const x1 = s.x + ux * s.r, y1 = s.y + uy * s.r;
              const x2 = t.x - ux * (t.r + 6), y2 = t.y - uy * (t.r + 6);
              // curve offset so opposing edges of a mutual pair don't overlap
              const bend = 22;
              const mx = (x1 + x2) / 2 - uy * bend;
              const my = (y1 + y2) / 2 + ux * bend;
              const active = hoverId == null || e.source === hoverId || e.target === hoverId;
              const width = 0.75 + (e.weight / maxWeight) * 2.25; // 0.75–3px
              return (
                <path
                  key={i}
                  d={`M${x1},${y1} Q${mx},${my} ${x2},${y2}`}
                  fill="none"
                  stroke={isCycle ? "var(--danger)" : "var(--text-secondary)"}
                  strokeWidth={width}
                  strokeOpacity={active ? (isCycle ? 0.6 : 0.35) : 0.06}
                  strokeDasharray={isCycle ? "5 4" : undefined}
                  markerEnd={`url(#${isCycle ? "mm-arrow-cycle" : "mm-arrow"})`}
                />
              );
            })}

            {/* connected module cards */}
            {positioned.map((n, i) => renderCard(n, i))}
            {/* isolated modules (no dependency edges) parked along the bottom */}
            {isolated.map((n, i) => renderCard(n, positioned.length + i, true))}
          </svg>
        )}
      </div>
    </div>
  );

  function renderCard(n: Positioned, i: number, isIso = false) {
    const color = moduleColor(n.id, i);
    const isHover = n.id === hoverId;
    const canDrill = n.fileCount > 1;
    const fontSize = Math.min(14, Math.max(9, n.r / 3.5)) * fs;
    // Clamp the label to roughly the circle's inner width.
    const maxChars = Math.max(4, Math.floor((n.r * 1.7) / (fontSize * 0.55)));
    const label = n.label.length > maxChars ? n.label.slice(0, maxChars - 1) + "…" : n.label;
    return (
      <g
        key={n.id}
        transform={`translate(${n.x},${n.y})`}
        style={{ cursor: canDrill ? "pointer" : "default" }}
        onMouseEnter={() => setHoverId(n.id)}
        onMouseLeave={() => setHoverId((h) => (h === n.id ? null : h))}
        onClick={() => canDrill && drillInto(n)}
      >
        <circle
          r={n.r}
          fill={color}
          fillOpacity={isHover ? 0.3 : isIso ? 0.1 : 0.18}
          stroke={color}
          strokeOpacity={isIso ? 0.5 : 1}
          strokeWidth={isHover ? 2.5 : 1.5}
        />
        <text textAnchor="middle" y={isIso ? 3 : -2} fontSize={fontSize} fontWeight={600} fill="var(--text-primary)" style={{ pointerEvents: "none" }}>
          {label}
        </text>
        {!isIso && (
          <text textAnchor="middle" y={fontSize + 3} fontSize={9.5 * fs} fill="var(--text-tertiary)" style={{ pointerEvents: "none" }}>
            {n.fileCount}f · {n.symbolCount}s
          </text>
        )}
        {canDrill && isHover && (
          <text textAnchor="middle" y={n.r + 13} fontSize={9 * fs} fill="var(--accent)" style={{ pointerEvents: "none" }}>
            open →
          </text>
        )}
      </g>
    );
  }
}
