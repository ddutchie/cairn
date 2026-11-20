"use client";

/**
 * People view, "Bridges": the people you reach others through. The graph rings
 * anyone who is your only route to someone; beside it, for each, who would be
 * cut off if they were out of the picture. People with no link to you are
 * listed so you can connect them.
 */
import React, { useMemo, useState } from "react";
import { Network } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { PanelHeading } from "@/components/ui/panel";
import { FOCUS_RING } from "@/components/ui/button";
import { OpenPersonContext, usePeopleNetwork } from "@/components/graph/peopleCanvasShared";
import { useFontScale } from "@/lib/viz/hooks";
import { cn } from "@/lib/utils";
import { truncateName } from "@/components/graph/analyticsUtils";
import { layoutNetwork } from "@/lib/people/layout";
import { DEFAULT_LINK_KINDS, deriveLinks, filterLinks } from "@/lib/people/network";
import { buildBridges } from "@/lib/people/bridges";

const W = 640;
const H = 440;

export function BridgesCanvas({ selectedId }: { selectedId?: string | null }) {
  const fs = useFontScale();
  const { people, network, loading } = usePeopleNetwork();
  const open = React.useContext(OpenPersonContext);
  const [focus, setFocus] = useState<string | null>(null);

  const model = useMemo(() => {
    const links = filterLinks(deriveLinks(people, network.edges, []), new Set(DEFAULT_LINK_KINDS));
    return buildBridges(people, links);
  }, [people, network]);
  const positions = useMemo(() => layoutNetwork(model.nodeIds, model.links, W, H), [model]);
  const byId = useMemo(() => new Map(people.map((p) => [p.id, p])), [people]);
  const bridgeIds = useMemo(() => new Set(model.dependencies.map((d) => d.person.id)), [model]);

  if (loading) return null;
  if (!model.me) return <EmptyState icon={Network} title="Mark yourself first" description="Bridges starts from you. Mark one person as you in People and the routes to everyone else show here." className="h-full" />;
  if (people.length < 2) return <EmptyState icon={Network} title="No people yet" description="Add the people you work with and link them to see who connects you to whom." className="h-full" />;

  const font = 10.5 * fs;
  const meId = model.me.id;
  return (
    <div className="h-full overflow-y-auto px-6 py-5">
      <div className="max-w-[1240px]">
        <p className="mb-7 max-w-[62ch] text-base leading-relaxed text-[var(--text-secondary)] text-pretty">
          People you reach others through. If one of them were out of the picture, these people would drop off your map.
        </p>
        <div className="grid gap-7 @4xl:grid-cols-[1.55fr_0.95fr]">
          <section aria-label="Your network">
            <PanelHeading title="Your network" note="Select a person to see who depends on them" />
            <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 shadow-elev-1">
              <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="group" aria-label={`Network of ${model.nodeIds.length} people`}>
                {model.links.map((l) => {
                  const a = positions.get(l.source); const b = positions.get(l.target);
                  if (!a || !b) return null;
                  return <line key={l.id} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="var(--border)" strokeWidth={1.5} />;
                })}
                {model.nodeIds.map((id) => {
                  const pt = positions.get(id); const p = byId.get(id);
                  if (!pt || !p) return null;
                  const isMe = id === meId; const bridge = bridgeIds.has(id); const on = focus === id || selectedId === id;
                  return (
                    <g
                      key={id} transform={`translate(${pt.x},${pt.y})`} role="button" tabIndex={0} className="cursor-pointer outline-none [&:focus-visible>circle]:stroke-[var(--accent)]"
                      aria-label={`${p.name}${isMe ? " (you)" : ""}${bridge ? ", only route to others" : ""}`}
                      onClick={() => { setFocus(id); open?.(id); }}
                      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setFocus(id); open?.(id); } }}
                    >
                      <circle r={isMe ? 11 : 7} fill={isMe ? "var(--accent)" : "var(--surface)"} stroke={bridge || on ? "var(--accent)" : "var(--text-tertiary)"} strokeWidth={bridge || on ? 3 : 1.5} />
                      <text y={-14} textAnchor="middle" fontSize={font} fill="var(--text-primary)" pointerEvents="none">{truncateName(p.name.split(" ")[0], 12)}</text>
                    </g>
                  );
                })}
              </svg>
              <div className="mt-3 flex flex-wrap gap-4 text-xs text-[var(--text-secondary)]">
                <span className="inline-flex items-center gap-1.5"><span className="size-2 rounded-full border-2 border-[var(--accent)]" aria-hidden />Only route to someone</span>
                <span className="inline-flex items-center gap-1.5"><span className="size-2 rounded-full border border-[var(--text-tertiary)] bg-[var(--surface)]" aria-hidden />Everyone else</span>
              </div>
            </div>
          </section>
          <div>
            <section aria-label="Single points of dependence">
              <PanelHeading title="Single points of dependence" note={String(model.dependencies.length)} />
              {model.dependencies.length === 0 ? (
                <p className="text-xs text-[var(--text-tertiary)]">Nobody is your only route to anyone else.</p>
              ) : (
                <ul className="space-y-2.5">
                  {model.dependencies.map((d) => (
                    <li
                      key={d.person.id}
                      className={cn("rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-2)] p-3 shadow-elev-1", focus === d.person.id && "bg-[var(--accent-dim)]")}
                    >
                      <p className="text-2xs text-[var(--text-tertiary)]">Only route to {d.cutOff.length} {d.cutOff.length === 1 ? "person" : "people"}</p>
                      <button type="button" onClick={() => { setFocus(d.person.id); open?.(d.person.id); }} className={cn("mt-0.5 rounded text-sm font-medium text-[var(--text-primary)] hover:underline", FOCUS_RING)}>{d.person.name}</button>
                      <ul className="mt-1.5 flex flex-wrap gap-1">
                        {d.cutOff.map((c) => (
                          <li key={c.id}>
                            <button type="button" onClick={() => open?.(c.id)} className={cn("rounded border border-[var(--border-subtle)] bg-[var(--surface)] px-1.5 py-0.5 text-xs text-[var(--text-secondary)] hover:bg-[var(--surface-3)]", FOCUS_RING)}>{c.name}</button>
                          </li>
                        ))}
                      </ul>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <section aria-label="Not connected to you" className="mt-9">
              <PanelHeading title="Not connected to you" note={String(model.disconnected.length)} />
              {model.disconnected.length === 0 ? (
                <p className="text-xs text-[var(--text-tertiary)]">Everyone is reachable from you.</p>
              ) : (
                <>
                  <ul className="flex flex-wrap gap-1.5">
                    {model.disconnected.map((p) => (
                      <li key={p.id}><button type="button" onClick={() => open?.(p.id)} className={cn("rounded border border-[var(--border-subtle)] px-2 py-1 text-xs text-[var(--text-secondary)] hover:bg-[var(--surface-2)]", FOCUS_RING)}>{p.name}</button></li>
                    ))}
                  </ul>
                  <p className="mt-2 text-2xs text-[var(--text-tertiary)]">Link them to someone on their page to bring them in.</p>
                </>
              )}
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}
