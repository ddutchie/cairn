"use client";

/**
 * A person's connections: a small picture of who they are linked to, with the
 * person in the middle. It is the relationships map's canvas
 * (`ForceGraphCanvas`) over the part of the people graph within one or two
 * links of them (`neighbourhoodGraph`), drawn compact and static. Click a
 * neighbour to go to them. Renders nothing for a person with no links, so a
 * page never carries an empty box.
 */
import React, { useCallback, useMemo, useState } from "react";
import { useCairnStore } from "@/store";
import { PanelHeading } from "@/components/ui/panel";
import { cn } from "@/lib/utils";
import { ForceGraphCanvas } from "@/components/graph/ForceGraphCanvas";
import { neighbourhoodGraph, type NeighbourhoodHops } from "@/components/graph/neighbourhood";
import { LINK_COLOR, useOpenPerson, usePeopleNetwork } from "@/components/graph/peopleCanvasShared";
import { buildPeopleGraph } from "@/lib/people/graph";
import { DEFAULT_LINK_KINDS, LINK_KIND_LABELS, deriveLinks, filterLinks, findMe, type LinkKind } from "@/lib/people/network";

const SPACING = 1.1;

function Toggle({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button" aria-pressed={on} onClick={onClick}
      className={cn(
        "px-2 py-0.5 rounded text-xs border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]",
        on ? "border-[var(--border)] bg-[var(--surface-2)] text-[var(--text-primary)]" : "border-[var(--border-subtle)] text-[var(--text-tertiary)]",
      )}
    >
      {children}
    </button>
  );
}

export function ConnectionsGraph({ personId, compact = false }: { personId: string; compact?: boolean }) {
  const open = useOpenPerson();
  const workspaceId = useCairnStore((s) => s.activeWorkspaceId) ?? "";
  const { people, network, loading } = usePeopleNetwork();
  const [hops, setHops] = useState<NeighbourhoodHops>(1);
  const [meetings, setMeetings] = useState(false);
  const [focusId, setFocusId] = useState<string | null>(null);

  const allLinks = useMemo(() => deriveLinks(people, network.edges, network.coAttendance), [people, network]);
  const kinds = useMemo<ReadonlySet<LinkKind>>(
    () => new Set<LinkKind>(meetings ? [...DEFAULT_LINK_KINDS, "meeting"] : DEFAULT_LINK_KINDS),
    [meetings],
  );
  const links = useMemo(() => filterLinks(allLinks, kinds), [allLinks, kinds]);
  const hasMeetings = useMemo(
    () => allLinks.some((l) => l.kind === "meeting" && (l.source === personId || l.target === personId)),
    [allLinks, personId],
  );
  const direct = useMemo(() => links.filter((l) => l.source === personId || l.target === personId), [links, personId]);

  const me = useMemo(() => findMe(people), [people]);
  const picture = useMemo(() => {
    if (direct.length === 0) return null;
    const { graph, styling } = buildPeopleGraph(people, links, me?.id ?? null, workspaceId, personId);
    const near = neighbourhoodGraph(graph, personId, hops);
    return near ? { graph: near, styling } : null;
  }, [direct.length, people, links, me, workspaceId, personId, hops]);

  const onNodeClick = useCallback((n: { id: string }) => { if (n.id !== personId) open(n.id); }, [open, personId]);
  const onBackgroundClick = useCallback(() => {}, []);

  const present = useMemo(() => {
    const s = new Set<LinkKind>();
    for (const l of direct) s.add(l.kind);
    return LINK_KINDS_ORDER.filter((k) => s.has(k));
  }, [direct]);

  if (loading || (!picture && !hasMeetings)) return null;
  const neighbours = picture ? picture.graph.nodes.length - 1 : 0;

  return (
    <section className="mb-9" aria-label="Connections">
      <PanelHeading
        title="Connections"
        note={picture ? `${neighbours} ${neighbours === 1 ? "person" : "people"}` : "Only meetings together"}
        action={(
          <div className="flex items-center gap-1">
            {hasMeetings && <Toggle on={meetings} onClick={() => setMeetings((v) => !v)}>Meetings together</Toggle>}
            {picture && <Toggle on={hops === 2} onClick={() => setHops((h) => (h === 1 ? 2 : 1))}>Their links</Toggle>}
          </div>
        )}
      />
      {picture && (
        <>
          <div
            className="rounded-md border border-[var(--border-subtle)] bg-[var(--surface)]"
            style={{ height: compact ? 220 : 280 }}
            role="group"
            aria-label={`${neighbours} ${neighbours === 1 ? "person" : "people"} linked to this person`}
          >
            <ForceGraphCanvas
              graph={picture.graph}
              styling={picture.styling}
              selectedNodeId={personId}
              focusNodeId={focusId}
              onNodeClick={onNodeClick}
              onBackgroundClick={onBackgroundClick}
              labelMode="all"
              spacing={SPACING}
              showHulls={false}
              compact
              layoutKey={`connections:${workspaceId}:${personId}:${hops}:${meetings ? 1 : 0}`}
            />
          </div>
          <ul className="flex flex-wrap gap-x-3 gap-y-1 mt-2 text-2xs text-[var(--text-tertiary)]" aria-label="Link types shown">
            {present.map((k) => (
              <li key={k} className="flex items-center gap-1">
                <span className="rounded-full" style={{ width: 6, height: 6, background: LINK_COLOR[k] }} />
                {LINK_KIND_LABELS[k]}
              </li>
            ))}
          </ul>
          <ul className="sr-only" aria-label="People linked to this person">
            {picture.graph.nodes.filter((n) => n.id !== personId).map((n) => (
              <li key={n.id}>
                <button
                  type="button" onClick={() => open(n.id)}
                  onFocus={() => setFocusId(n.id)} onBlur={() => setFocusId((c) => (c === n.id ? null : c))}
                >
                  {`${n.title}. Open person`}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

const LINK_KINDS_ORDER: readonly LinkKind[] = ["reporting", "mentor", "buddy", "stakeholder", "peer", "partner", "meeting"];
