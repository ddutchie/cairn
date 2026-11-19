"use client";

/**
 * Org chart (Insights, People layer W7): the reporting tree from `manager_of`
 * edges, anchored on the `is_me` person, whose line to the top is highlighted.
 * Several roots sit side by side; people with no reporting link are listed
 * under the chart. Click or Enter on a card opens the person.
 */
import React, { useEffect, useMemo, useRef } from "react";
import { useFontScale } from "@/lib/viz/hooks";
import { CanvasEmptyState } from "./AnalyticsShared";
import { truncateName } from "./analyticsUtils";
import { useOpenPerson, usePeopleNetwork } from "./peopleCanvasShared";
import { ORG_CARD_H, ORG_CARD_W, layoutOrg } from "@/lib/people/layout";
import { buildOrgChart, deriveLinks, findMe, pathTo } from "@/lib/people/network";
import { RELATIONSHIP_LABELS } from "@/components/people/people-model";

export function OrgChartCanvas() {
  const fs = useFontScale();
  const open = useOpenPerson();
  const scrollRef = useRef<HTMLDivElement>(null);
  const { people, network, loading } = usePeopleNetwork();

  const links = useMemo(() => deriveLinks(people, network.edges, []), [people, network]);
  const chart = useMemo(() => buildOrgChart(people, links), [people, links]);
  const layout = useMemo(() => layoutOrg(chart.roots), [chart.roots]);
  const me = useMemo(() => findMe(people), [people]);
  const myLine = useMemo(() => new Set(me ? pathTo(chart.roots, me.id) : []), [chart.roots, me]);
  const byId = useMemo(() => new Map(people.map((p) => [p.id, p])), [people]);
  const pos = useMemo(() => new Map(layout.nodes.map((n) => [n.id, n])), [layout]);

  // Bring the "me" card into view when the chart first has one.
  const meX = me ? pos.get(me.id)?.x : undefined;
  useEffect(() => {
    const el = scrollRef.current;
    if (el && meX !== undefined) el.scrollLeft = Math.max(0, meX + ORG_CARD_W / 2 - el.clientWidth / 2);
  }, [meX, loading]);

  if (loading) return null;
  if (people.length === 0) return <CanvasEmptyState message="No people yet. Add people in the People view and the reporting line shows up here." />;

  const nameFont = 11 * fs;
  const subFont = 9 * fs;
  // Truncate by estimated width so text stays inside the fixed card at any font scale.
  const nameMax = Math.max(8, Math.floor((ORG_CARD_W - 20) / (0.55 * nameFont)));
  const subMax = Math.max(8, Math.floor((ORG_CARD_W - 20) / (0.52 * subFont)));
  const onlyMe = chart.roots.length === 1 && chart.roots[0].children.length === 0 && chart.roots[0].alsoReportsTo.length === 0;
  return (
    <div className="flex flex-col flex-1 min-w-0 min-h-0">
      {(onlyMe || chart.roots.length === 0) && (
        <p role="status" className="px-3 py-1.5 text-xs text-[var(--text-tertiary)] border-b border-[var(--border-subtle)]">
          No reporting lines yet. Set who manages whom on a person&apos;s page, or give people the Manager or Direct report relationship.
        </p>
      )}
      {chart.cyclesBroken > 0 && (
        <p role="status" className="px-3 py-1.5 text-xs text-[var(--warning)] border-b border-[var(--border-subtle)]">
          {chart.cyclesBroken === 1 ? "A reporting loop" : `${chart.cyclesBroken} reporting loops`} in your data {chart.cyclesBroken === 1 ? "was" : "were"} cut so the chart can draw. Check the manager links.
        </p>
      )}
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-auto" tabIndex={-1}>
        {chart.roots.length > 0 && <svg
          width={layout.width} height={layout.height} role="group"
          aria-label={`Org chart of ${layout.nodes.length} people in ${chart.roots.length} ${chart.roots.length === 1 ? "tree" : "trees"}`}
          className="block"
        >
          {layout.links.map((l) => {
            const a = pos.get(l.from); const b = pos.get(l.to);
            if (!a || !b) return null;
            const x1 = a.x + ORG_CARD_W / 2; const y1 = a.y + ORG_CARD_H;
            const x2 = b.x + ORG_CARD_W / 2; const y2 = b.y;
            const midY = (y1 + y2) / 2;
            const onLine = myLine.has(l.from) && myLine.has(l.to);
            return (
              <path
                key={l.id} d={`M${x1},${y1} V${midY} H${x2} V${y2}`} fill="none"
                stroke={onLine ? "var(--accent)" : "var(--border)"} strokeWidth={onLine ? 2 : 1.25}
              />
            );
          })}
          {layout.nodes.map(({ id, node, x, y }) => {
            const p = node.person;
            const isMe = me?.id === id;
            const rel = p.relationship[0] ? (p.relationship[0].label || RELATIONSHIP_LABELS[p.relationship[0].type]) : "";
            const extra = node.alsoReportsTo.map((m) => byId.get(m)?.name).filter(Boolean);
            const alsoText = extra.length ? `Also reports to ${extra.join(", ")}` : "";
            const sub = isMe ? ["You", alsoText].filter(Boolean).join(" · ") : alsoText || rel;
            const reports = node.children.length;
            return (
              <g
                key={id} transform={`translate(${x},${y})`} role="button" tabIndex={0}
                aria-label={`${p.name}${isMe ? " (you)" : ""}${isMe ? (alsoText ? `, ${alsoText}` : "") : sub ? `, ${sub}` : ""}${reports ? `, ${reports} direct ${reports === 1 ? "report" : "reports"}` : ""}${node.cycleBroken ? ", manager link cut to break a loop" : ""}. Open person`}
                className="cursor-pointer outline-none [&:focus-visible>rect]:stroke-[var(--accent)] [&:focus-visible>rect]:stroke-[2.5]"
                onClick={() => open(id)}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(id); } }}
              >
                <rect
                  width={ORG_CARD_W} height={ORG_CARD_H} rx={8}
                  fill={isMe ? "var(--accent-dim)" : "var(--surface)"}
                  stroke={isMe || myLine.has(id) ? "var(--accent)" : "var(--border)"} strokeWidth={isMe ? 2 : 1}
                />
                <text x={10} y={ORG_CARD_H / 2 - (sub ? 2 : -4)} fontSize={nameFont} fontWeight={500} fill="var(--text-primary)" pointerEvents="none">
                  {truncateName(p.name, nameMax)}
                </text>
                {sub && (
                  <text x={10} y={ORG_CARD_H / 2 + 11} fontSize={subFont} fill="var(--text-tertiary)" pointerEvents="none">
                    {truncateName(sub, subMax)}
                  </text>
                )}
                {node.cycleBroken && <title>Their manager link was cut to break a loop</title>}
              </g>
            );
          })}
        </svg>}

        {chart.unplaced.length > 0 && (
          <div className="px-3 pb-3 pt-1 border-t border-[var(--border-subtle)]">
            <p className="py-1.5 text-xs text-[var(--text-tertiary)]">Not in a reporting line ({chart.unplaced.length})</p>
            <ul className="flex flex-wrap gap-1.5 max-h-40 overflow-auto">
              {chart.unplaced.map((p) => (
                <li key={p.id}>
                  <button
                    type="button" onClick={() => open(p.id)}
                    className="px-2 py-1 rounded border border-[var(--border-subtle)] text-xs text-[var(--text-secondary)] hover:bg-[var(--surface-2)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                  >
                    {p.name}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
