"use client";

/**
 * Relationship canvas (Insights, People layer W7): people as nodes, the links
 * between them as lines. It is the Knowledge Graph's force canvas fed a
 * people-only graph (`buildPeopleGraph`), so layout, zoom, labels and
 * remembered positions are shared with it. Colour and dash carry the kind (see
 * the chips); line weight on "meetings together" is how many meetings they
 * shared. Click opens a person; a visually hidden list keeps every person
 * reachable from the keyboard. The user's own picture of their people; nothing
 * here counts activity.
 */
import React, { useMemo, useState } from "react";
import { useCairnStore } from "@/store";
import { CanvasEmptyState } from "./AnalyticsShared";
import { ForceGraphCanvas } from "./ForceGraphCanvas";
import { LinkKindChip, useOpenPerson, usePeopleNetwork } from "./peopleCanvasShared";
import { buildPeopleGraph } from "@/lib/people/graph";
import {
  DEFAULT_LINK_KINDS, LINK_KINDS, deriveLinks, filterLinks, findMe, type LinkKind,
} from "@/lib/people/network";

const LABEL_ALL_BELOW = 80;
/** Spacing for the people layout (1 = the Knowledge Graph's default). */
const SPACING = 1.4;

export function RelationshipCanvas() {
  const open = useOpenPerson();
  const workspaceId = useCairnStore((s) => s.activeWorkspaceId) ?? "";
  const { people, network, loading } = usePeopleNetwork();
  const [kinds, setKinds] = useState<ReadonlySet<LinkKind>>(() => new Set(DEFAULT_LINK_KINDS));
  const [selectedId, setSelectedId] = useState<string | null>(null);

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
  const degree = useMemo(() => {
    const d = new Map<string, number>();
    for (const l of links) { d.set(l.source, (d.get(l.source) ?? 0) + 1); d.set(l.target, (d.get(l.target) ?? 0) + 1); }
    return d;
  }, [links]);

  const { graph, styling } = useMemo(
    () => buildPeopleGraph(shown, links, me?.id ?? null, workspaceId),
    [shown, links, me, workspaceId],
  );
  const onNodeClick = React.useCallback((n: { id: string }) => { setSelectedId(n.id); open(n.id); }, [open]);
  const onBackgroundClick = React.useCallback(() => setSelectedId(null), []);

  if (loading) return null;
  if (people.length === 0) return <CanvasEmptyState message="No people yet. Add people in the People view and their relationships show up here." />;

  const summary = `Relationship map of ${shown.length} people and ${links.length} links.`;

  return (
    <div className="relative flex flex-1 min-w-0 overflow-hidden">
      <div className="absolute top-2 left-3 right-3 z-10 flex flex-wrap items-center gap-1.5" role="group" aria-label="Show relationship types">
        {LINK_KINDS.map((k) => (
          <LinkKindChip
            key={k} kind={k} count={counts[k]} active={kinds.has(k)}
            onToggle={() => setKinds((prev) => { const next = new Set(prev); if (next.has(k)) next.delete(k); else next.add(k); return next; })}
          />
        ))}
        {!me && people.some((p) => p.relationship.length > 0) && (
          <span className="ml-1 text-xs text-[var(--text-tertiary)]">Links to you need a person marked &quot;This is me&quot;: add yourself, then Edit</span>
        )}
        {hiddenCount > 0 && (
          <span className="ml-1 text-xs text-[var(--text-tertiary)]">{hiddenCount} without a link here</span>
        )}
      </div>

      {links.length === 0 ? (
        <CanvasEmptyState message={allLinks.length === 0
          ? "No relationships yet. Set a manager, mentor or stakeholder on a person's page, or add yourself as a person, turn on \"This is me\" and give people a relationship to you."
          : "Nothing to show with these filters. Turn a relationship type back on."} />
      ) : (
        <>
          <ForceGraphCanvas
            graph={graph}
            styling={styling}
            selectedNodeId={selectedId}
            onNodeClick={onNodeClick}
            onBackgroundClick={onBackgroundClick}
            labelMode={shown.length <= LABEL_ALL_BELOW ? "all" : "smart"}
            spacing={SPACING}
            showHulls={false}
            layoutKey={`people:${workspaceId}`}
          />
          <ul className="sr-only" aria-label={summary}>
            {shown.map((p) => {
              const deg = degree.get(p.id) ?? 0;
              return (
                <li key={p.id}>
                  <button type="button" onClick={() => open(p.id)}>
                    {`${p.name}${me?.id === p.id ? " (you)" : ""}, ${deg} ${deg === 1 ? "link" : "links"}. Open person`}
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}
