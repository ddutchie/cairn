"use client";

/**
 * People view, "Bridges": the people you reach others through. The picture is
 * the relationship map's force canvas (`ForceGraphCanvas` over
 * `buildPeopleGraph`), so it zooms, pans and remembers its layout like the
 * Knowledge Graph; anyone who is your only route to someone gets a ring.
 * Beside it, for each of them, who would be cut off if they were out of the
 * picture. People with no link to you are listed so you can connect them.
 */
import React, { useCallback, useMemo, useState } from "react";
import { Network } from "lucide-react";
import { useCairnStore } from "@/store";
import { EmptyState } from "@/components/ui/empty-state";
import { PeopleCanvasPage } from "./PeopleCanvasPage";
import { PanelHeading } from "@/components/ui/panel";
import { FOCUS_RING } from "@/components/ui/button";
import { OpenPersonContext, usePeopleNetwork } from "@/components/graph/peopleCanvasShared";
import { ForceGraphCanvas, type ForceGraphStyling } from "@/components/graph/ForceGraphCanvas";
import { cn } from "@/lib/utils";
import { buildPeopleGraph } from "@/lib/people/graph";
import { DEFAULT_LINK_KINDS, deriveLinks, filterLinks } from "@/lib/people/network";
import { buildBridges } from "@/lib/people/bridges";
import { PersonAvatar } from "./PersonAvatar";

export function BridgesCanvas({ selectedId }: { selectedId?: string | null }) {
  const { people, network, loading } = usePeopleNetwork();
  const workspaceId = useCairnStore((s) => s.activeWorkspaceId) ?? "";
  const open = React.useContext(OpenPersonContext);
  const [focus, setFocus] = useState<string | null>(null);

  const model = useMemo(() => {
    const links = filterLinks(deriveLinks(people, network.edges, []), new Set(DEFAULT_LINK_KINDS));
    return buildBridges(people, links);
  }, [people, network]);
  const bridgeIds = useMemo(() => new Set(model.dependencies.map((d) => d.person.id)), [model]);
  const cutOffBy = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const d of model.dependencies) m.set(d.person.id, new Set(d.cutOff.map((c) => c.id)));
    return m;
  }, [model]);

  const picture = useMemo(() => {
    const shown = people.filter((p) => model.nodeIds.includes(p.id));
    const base = buildPeopleGraph(shown, model.links, model.me?.id ?? null, workspaceId);
    const baseNode = base.styling.node;
    // Rings for the only routes; the people a selected bridge would cut off take the warning tone.
    const styling: ForceGraphStyling = {
      ...base.styling,
      node: (n) => {
        const own = baseNode?.(n);
        const ring = bridgeIds.has(n.id);
        const cut = !!focus && !!cutOffBy.get(focus)?.has(n.id);
        if (!ring && !cut) return own;
        return { ...own, ...(cut ? { token: "warning" as const } : {}), ...(ring ? { ring: "accent" as const, label: true } : {}) };
      },
    };
    return { graph: base.graph, styling };
  }, [people, model, workspaceId, bridgeIds, cutOffBy, focus]);

  const pick = useCallback((id: string) => { setFocus(id); open?.(id); }, [open]);
  const onNodeClick = useCallback((n: { id: string }) => pick(n.id), [pick]);
  const onBackgroundClick = useCallback(() => setFocus(null), []);

  if (loading) return null;
  if (!model.me) return <EmptyState icon={Network} title="Mark yourself first" description="Bridges starts from you. Mark one person as you in People and the routes to everyone else show here." className="h-full" />;
  if (people.length < 2) return <EmptyState icon={Network} title="No people yet" description="Add the people you work with and link them to see who connects you to whom." className="h-full" />;

  const chip = (id: string, name: string, onClick: () => void, extra?: string) => (
    <button
      type="button" onClick={onClick}
      className={cn("inline-flex items-center gap-1.5 rounded-full border border-[var(--border-subtle)] bg-[var(--surface)] py-0.5 pl-0.5 pr-2.5 text-xs text-[var(--text-secondary)] hover:bg-[var(--surface-3)]", FOCUS_RING, extra)}
    >
      <PersonAvatar name={name} size="xs" />{name}
    </button>
  );

  return (
    <PeopleCanvasPage lede="People you reach others through. If one of them were out of the picture, these people would drop off your map.">
      <div className="grid gap-7 @4xl:grid-cols-[1.55fr_0.95fr]">
        <section aria-label="Your network">
          <PanelHeading title="Your network" note="Select someone with a ring to see who depends on them" />
          <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] shadow-elev-1 overflow-hidden">
            <div className="relative flex h-[30rem]" role="group" aria-label={`Network of ${model.nodeIds.length} people`}>
              <ForceGraphCanvas
                graph={picture.graph}
                styling={picture.styling}
                selectedNodeId={focus ?? selectedId ?? null}
                onNodeClick={onNodeClick}
                onBackgroundClick={onBackgroundClick}
                labelMode={model.nodeIds.length <= 80 ? "all" : "smart"}
                spacing={1.3}
                showHulls={false}
                layoutKey={`people:${workspaceId}`}
              />
            </div>
            <div className="flex flex-wrap gap-4 border-t border-[var(--border-subtle)] px-4 py-2.5 text-xs text-[var(--text-secondary)]">
              <span className="inline-flex items-center gap-1.5"><span className="size-2.5 rounded-full border-2 border-[var(--accent)]" aria-hidden />Only route to someone</span>
              <span className="inline-flex items-center gap-1.5"><span className="size-2 rounded-full bg-[var(--warning)]" aria-hidden />Cut off without the selected person</span>
            </div>
            <ul className="sr-only" aria-label="People in your network">
              {model.nodeIds.map((id) => {
                const p = people.find((x) => x.id === id);
                if (!p) return null;
                return (
                  <li key={id}>
                    <button type="button" onClick={() => pick(id)}>
                      {`${p.name}${id === model.me!.id ? " (you)" : ""}${bridgeIds.has(id) ? ", only route to others" : ""}`}
                    </button>
                  </li>
                );
              })}
            </ul>
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
                    className={cn("rounded-lg border bg-[var(--surface-2)] p-3 shadow-elev-1", focus === d.person.id ? "border-[var(--accent)]" : "border-[var(--border-subtle)]")}
                  >
                    <button type="button" onClick={() => pick(d.person.id)} className={cn("flex w-full items-center gap-2 rounded text-left", FOCUS_RING)}>
                      <PersonAvatar name={d.person.name} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-[var(--text-primary)] hover:underline">{d.person.name}</span>
                        <span className="block text-2xs text-[var(--text-tertiary)]">Only route to {d.cutOff.length} {d.cutOff.length === 1 ? "person" : "people"}</span>
                      </span>
                    </button>
                    <ul className="mt-2 flex flex-wrap gap-1">
                      {d.cutOff.map((c) => <li key={c.id}>{chip(c.id, c.name, () => open?.(c.id))}</li>)}
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
                  {model.disconnected.map((p) => <li key={p.id}>{chip(p.id, p.name, () => open?.(p.id))}</li>)}
                </ul>
                <p className="mt-2 text-2xs text-[var(--text-tertiary)]">Link them to someone on their page to bring them in.</p>
              </>
            )}
          </section>
        </div>
      </div>
    </PeopleCanvasPage>
  );
}
