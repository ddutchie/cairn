"use client";

/**
 * Relationship canvas (Insights, People layer W7): people as nodes, the links
 * between them as lines. Colour and dash carry the kind (see the chips), line
 * weight on "meetings together" is how many meetings they shared. Click or
 * Enter on a person opens their page. The user's own picture of their people;
 * nothing here counts activity.
 */
import React, { useEffect, useMemo, useRef, useState } from "react";
import * as d3 from "d3";
import { useContainerDims, useFontScale } from "@/lib/viz/hooks";
import { CanvasEmptyState } from "./AnalyticsShared";
import { truncateName } from "./analyticsUtils";
import { LINK_COLOR, LinkKindChip, useOpenPerson, usePeopleNetwork } from "./peopleCanvasShared";
import { layoutNetwork } from "@/lib/people/layout";
import {
  DEFAULT_LINK_KINDS, LINK_KINDS, LINK_KIND_LABELS, deriveLinks, filterLinks, findMe, type LinkKind,
} from "@/lib/people/network";

const LABEL_ALL_BELOW = 80;
const NODE_R = 6;

export function RelationshipCanvas() {
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const fs = useFontScale();
  const dims = useContainerDims(containerRef);
  // Rounded so a live resize doesn't re-run the layout on every pixel.
  const width = Math.max(100, Math.round(dims.width / 50) * 50);
  const height = Math.max(100, Math.round(dims.height / 50) * 50);
  const open = useOpenPerson();
  const { people, network, loading } = usePeopleNetwork();
  const [kinds, setKinds] = useState<ReadonlySet<LinkKind>>(() => new Set(DEFAULT_LINK_KINDS));
  const [focusId, setFocusId] = useState<string | null>(null);
  const [zoom, setZoom] = useState({ k: 1, x: 0, y: 0 });
  const zoomRef = useRef(zoom);
  useEffect(() => { zoomRef.current = zoom; }, [zoom]);

  const allLinks = useMemo(() => deriveLinks(people, network.edges, network.coAttendance), [people, network]);
  const counts = useMemo(() => {
    const c: Record<LinkKind, number> = { reporting: 0, mentor: 0, buddy: 0, stakeholder: 0, peer: 0, partner: 0, meeting: 0 };
    for (const l of allLinks) c[l.kind]++;
    return c;
  }, [allLinks]);
  const links = useMemo(() => filterLinks(allLinks, kinds), [allLinks, kinds]);
  const me = useMemo(() => findMe(people), [people]);

  // People with a visible link, plus me. Everyone else is counted, not drawn.
  const shown = useMemo(() => {
    const linked = new Set<string>();
    for (const l of links) { linked.add(l.source); linked.add(l.target); }
    if (me) linked.add(me.id);
    return people.filter((p) => linked.has(p.id));
  }, [people, links, me]);
  const hiddenCount = people.length - shown.length;
  const byId = useMemo(() => new Map(people.map((p) => [p.id, p])), [people]);

  const ids = useMemo(() => shown.map((p) => p.id), [shown]);
  const positions = useMemo(() => layoutNetwork(ids, links, width, height), [ids, links, width, height]);

  const degree = useMemo(() => {
    const d = new Map<string, number>();
    for (const l of links) { d.set(l.source, (d.get(l.source) ?? 0) + 1); d.set(l.target, (d.get(l.target) ?? 0) + 1); }
    return d;
  }, [links]);
  const neighbours = useMemo(() => {
    if (!focusId) return null;
    const s = new Set<string>([focusId]);
    for (const l of links) { if (l.source === focusId) s.add(l.target); else if (l.target === focusId) s.add(l.source); }
    return s;
  }, [focusId, links]);

  // Wheel / drag zoom on the svg; the transform lives in state so labels can react to it.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const behaviour = d3.zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.5, 6])
      .extent([[0, 0], [dims.width, dims.height]])
      .filter((e: Event) => {
        if (e.type === "wheel") return true;
        if ((e as MouseEvent).button) return false;
        return !(e.target as Element | null)?.closest?.("[data-person]");
      })
      .on("zoom", (e) => setZoom({ k: e.transform.k, x: e.transform.x, y: e.transform.y }));
    const sel = d3.select(svg);
    sel.call(behaviour);
    // A fresh svg starts at identity; carry the current view over so the first gesture doesn't snap.
    sel.call(behaviour.transform, d3.zoomIdentity.translate(zoomRef.current.x, zoomRef.current.y).scale(zoomRef.current.k));
    return () => { sel.on(".zoom", null); };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- extent follows the size; re-binding per pixel isn't wanted
  }, [positions, links.length, loading]);

  if (loading) return null;
  if (people.length === 0) return <CanvasEmptyState message="No people yet. Add people in the People view and their relationships show up here." />;

  const showAllLabels = shown.length <= LABEL_ALL_BELOW || zoom.k >= 1.8;
  const labelSize = 10.5 * fs / Math.max(1, Math.min(zoom.k, 2.5)) ** 0.5;
  const summary = `Relationship map of ${shown.length} people and ${links.length} links.`;

  return (
    <div ref={containerRef} className="relative flex-1 min-w-0 overflow-hidden">
      <div className="absolute top-2 left-3 right-3 z-10 flex flex-wrap items-center gap-1.5" role="group" aria-label="Show relationship types">
        {LINK_KINDS.map((k) => (
          <LinkKindChip
            key={k} kind={k} count={counts[k]} active={kinds.has(k)}
            onToggle={() => setKinds((prev) => { const next = new Set(prev); if (next.has(k)) next.delete(k); else next.add(k); return next; })}
          />
        ))}
        {hiddenCount > 0 && (
          <span className="ml-1 text-xs text-[var(--text-tertiary)]">{hiddenCount} without a link here</span>
        )}
      </div>

      {links.length === 0 ? (
        <CanvasEmptyState message={allLinks.length === 0
          ? "No relationships yet. Set a manager, mentor or stakeholder on a person's page, or mark yourself and give people a relationship to you."
          : "Nothing to show with these filters. Turn a relationship type back on."} />
      ) : (
        <svg ref={svgRef} width={dims.width} height={dims.height} role="group" aria-label={summary} className="block select-none touch-none">
          <defs>
            {LINK_KINDS.map((k) => (
              <marker key={k} id={`rel-arrow-${k}`} viewBox="0 0 10 10" refX="18" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
                <path d="M0,0 L10,5 L0,10 z" fill={LINK_COLOR[k]} />
              </marker>
            ))}
          </defs>
          <g transform={`translate(${zoom.x},${zoom.y}) scale(${zoom.k})`}>
            {links.map((l) => {
              const a = positions.get(l.source); const b = positions.get(l.target);
              if (!a || !b) return null;
              const dim = neighbours && !(neighbours.has(l.source) && neighbours.has(l.target) && (l.source === focusId || l.target === focusId));
              return (
                <line
                  key={l.id} x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                  stroke={LINK_COLOR[l.kind]}
                  strokeWidth={(l.kind === "meeting" ? 0.8 + Math.log2(l.weight + 1) * 0.7 : 1.5) / zoom.k ** 0.5}
                  strokeDasharray={l.ended ? "2 4" : l.kind === "meeting" ? "6 3" : undefined}
                  strokeOpacity={dim ? 0.08 : l.kind === "meeting" ? 0.55 : 0.85}
                  markerEnd={l.directed ? `url(#rel-arrow-${l.kind})` : undefined}
                >
                  <title>{`${byId.get(l.source)?.name ?? ""} – ${byId.get(l.target)?.name ?? ""}: ${LINK_KIND_LABELS[l.kind]}${l.label ? ` (${l.label})` : ""}${l.ended ? ", former" : ""}${l.kind === "meeting" ? `, ${l.weight} ${l.weight === 1 ? "meeting" : "meetings"}` : ""}`}</title>
                </line>
              );
            })}
            {shown.map((p) => {
              const pos = positions.get(p.id);
              if (!pos) return null;
              const isMe = me?.id === p.id;
              const lit = !neighbours || neighbours.has(p.id);
              const labelled = showAllLabels || isMe || (!!neighbours && lit) || (degree.get(p.id) ?? 0) >= 4;
              const deg = degree.get(p.id) ?? 0;
              return (
                <g
                  key={p.id} data-person transform={`translate(${pos.x},${pos.y})`}
                  role="button" tabIndex={0}
                  aria-label={`${p.name}${isMe ? " (you)" : ""}, ${deg} ${deg === 1 ? "link" : "links"}. Open person`}
                  className="cursor-pointer outline-none [&:focus-visible>circle:first-child]:stroke-[var(--accent)] [&:focus-visible>circle:first-child]:stroke-[3]"
                  opacity={lit ? 1 : 0.25}
                  onClick={() => open(p.id)}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(p.id); } }}
                  onMouseEnter={() => setFocusId(p.id)} onMouseLeave={() => setFocusId((c) => (c === p.id ? null : c))}
                  onFocus={() => setFocusId(p.id)} onBlur={() => setFocusId((c) => (c === p.id ? null : c))}
                >
                  <circle r={(isMe ? NODE_R + 3 : NODE_R) / zoom.k ** 0.5} fill={isMe ? "var(--accent)" : "var(--node-person)"} stroke="var(--background)" strokeWidth={1.5} />
                  {labelled && (
                    <text
                      y={-(NODE_R + 5) / zoom.k ** 0.5} textAnchor="middle" fontSize={labelSize}
                      fill="var(--text-primary)" stroke="var(--background)" strokeWidth={3} paintOrder="stroke"
                      pointerEvents="none"
                    >
                      {truncateName(p.name, 22)}
                    </text>
                  )}
                </g>
              );
            })}
          </g>
        </svg>
      )}
    </div>
  );
}
