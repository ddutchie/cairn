"use client";

/**
 * Org chart (Insights and the People view). Two trees:
 *
 * - People: the reporting line from `manager_of` edges, anchored on the
 *   `is_me` person, whose line to the top is highlighted. Each card carries
 *   the person's role and team; picking a team dims everyone else, so a team
 *   spread across managers is easy to see. Several roots sit side by side and
 *   people with no reporting link are listed under the chart.
 * - Teams: the team tree from each team's "sits under", with its lead and size.
 *
 * Cards are HTML over an SVG of rounded elbows, so text follows the font
 * scale. Zoom with the buttons or ⌘/Ctrl + wheel. Click or Enter opens.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Maximize2, ZoomIn, ZoomOut } from "lucide-react";
import { useCairnStore } from "@/store";
import { cn } from "@/lib/utils";
import { FOCUS_RING } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { Select } from "@/components/ui/select";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { CanvasEmptyState } from "./AnalyticsShared";
import { useOpenPerson, usePeopleNetwork } from "./peopleCanvasShared";
import { ORG_CARD_H, ORG_CARD_W, elbowPath, layoutOrg, layoutTree } from "@/lib/people/layout";
import { buildOrgChart, deriveLinks, findMe, pathTo } from "@/lib/people/network";
import { RELATIONSHIP_LABELS } from "@/components/people/people-model";
import { PersonAvatar } from "@/components/people/PersonAvatar";
import { NO_TEAM_KEY, groupByTeam, peopleUnder, teamForest, type TeamNode } from "../../../shared/people/teams";

type OrgMode = "people" | "teams";
const ZOOMS = [0.5, 0.67, 0.8, 1, 1.25, 1.5] as const;

/** Scrollable, zoomable stage: an SVG of links under absolutely placed cards. */
function Stage({ width, height, zoom, scrollRef, onZoom, label, links, children }: {
  width: number; height: number; zoom: number; scrollRef: React.RefObject<HTMLDivElement | null>; onZoom: (dir: 1 | -1) => void;
  label: string; links: React.ReactNode; children: React.ReactNode;
}) {
  // ⌘/Ctrl + wheel zooms; a plain wheel scrolls as usual.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.metaKey && !e.ctrlKey) return;
      e.preventDefault();
      onZoom(e.deltaY < 0 ? 1 : -1);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [scrollRef, onZoom]);
  return (
    <div ref={scrollRef} className="flex-1 min-h-0 overflow-auto" tabIndex={-1}>
      <div style={{ width: width * zoom, height: height * zoom }}>
        <div role="group" aria-label={label} className="relative origin-top-left" style={{ width, height, transform: `scale(${zoom})` }}>
          <svg width={width} height={height} className="absolute inset-0 block" aria-hidden>{links}</svg>
          {children}
        </div>
      </div>
    </div>
  );
}

export function OrgChartCanvas({ onOpenTeam }: { onOpenTeam?: (key: string) => void } = {}) {
  const open = useOpenPerson();
  const scrollRef = useRef<HTMLDivElement>(null);
  const { people, network, loading } = usePeopleNetwork();
  const teams = useCairnStore((s) => s.teams);
  const [mode, setMode] = useState<OrgMode>("people");
  const [highlight, setHighlight] = useState<string>("");
  const [zoomIdx, setZoomIdx] = useState(3);
  const zoom = ZOOMS[zoomIdx];
  const step = useCallback((dir: 1 | -1) => setZoomIdx((i) => Math.max(0, Math.min(ZOOMS.length - 1, i + dir))), []);

  const links = useMemo(() => deriveLinks(people, network.edges, []), [people, network]);
  const chart = useMemo(() => buildOrgChart(people, links), [people, links]);
  const layout = useMemo(() => layoutOrg(chart.roots), [chart.roots]);
  const me = useMemo(() => findMe(people), [people]);
  const myLine = useMemo(() => new Set(me ? pathTo(chart.roots, me.id) : []), [chart.roots, me]);
  const byId = useMemo(() => new Map(people.map((p) => [p.id, p])), [people]);
  const pos = useMemo(() => new Map(layout.nodes.map((n) => [n.id, n])), [layout]);

  const groups = useMemo(() => groupByTeam(people, teams), [people, teams]);
  const forest = useMemo(() => teamForest(groups), [groups]);
  const teamLayout = useMemo(() => layoutTree<TeamNode>(forest, { id: (n) => n.group.key, children: (n) => n.children }), [forest]);
  const teamPos = useMemo(() => new Map(teamLayout.nodes.map((n) => [n.id, n])), [teamLayout]);
  const teamOptions = useMemo(() => groups
    .filter((g) => g.people.length > 0 && g.key !== NO_TEAM_KEY)
    .map((g) => ({ value: g.key, label: g.team }))
    .sort((a, b) => a.label.localeCompare(b.label)), [groups]);

  const fit = () => {
    const el = scrollRef.current;
    const w = mode === "people" ? layout.width : teamLayout.width;
    const h = mode === "people" ? layout.height : teamLayout.height;
    if (!el || !w || !h) return;
    const want = Math.min(1.5, el.clientWidth / w, el.clientHeight / h);
    let best = 0;
    ZOOMS.forEach((z, i) => { if (z <= want) best = i; });
    setZoomIdx(best);
  };

  // Bring the "me" card into view when the chart first has one.
  const meX = me ? pos.get(me.id)?.x : undefined;
  useEffect(() => {
    const el = scrollRef.current;
    if (el && meX !== undefined && mode === "people") el.scrollLeft = Math.max(0, (meX + ORG_CARD_W / 2) * zoom - el.clientWidth / 2);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only on first layout and mode switch, not on every zoom step
  }, [meX, loading, mode]);

  if (loading) return null;
  // With teams but no people the Teams chart still has something to show, so the toolbar stays.
  if (people.length === 0 && teams.length === 0) return <CanvasEmptyState message="No people yet. Add people in the People view and the reporting line shows up here." />;

  const onlyMe = chart.roots.length === 1 && chart.roots[0].children.length === 0 && chart.roots[0].alsoReportsTo.length === 0;
  // A highlighted team that no longer has anyone on it stops dimming everyone.
  const hl = teamOptions.some((o) => o.value === highlight) ? highlight : "";
  const onHl = new Set(groups.find((g) => g.key === hl)?.people.map((p) => p.id) ?? []);
  const dims = (personId: string | undefined) => !!hl && !onHl.has(personId ?? "");

  const toolbar = (
    <div className="flex min-h-12 flex-wrap items-center gap-2 px-3 py-2 border-b border-[var(--border-subtle)]">
      <SegmentedControl<OrgMode>
        ariaLabel="Org chart of" size="sm" value={mode} onChange={setMode}
        options={[{ value: "people", label: "Reporting line" }, { value: "teams", label: "Teams" }]}
      />
      {mode === "people" && teamOptions.length > 0 && (
        <Select<string>
          ariaLabel="Highlight a team" value={highlight} onChange={setHighlight}
          options={[{ value: "", label: "All teams" }, ...teamOptions]}
        />
      )}
      <div className="ml-auto flex items-center gap-0.5">
        <IconButton label="Zoom out" size="sm" onClick={() => step(-1)} disabled={zoomIdx === 0}><ZoomOut size={13} /></IconButton>
        <span className="w-10 text-center text-2xs tabular-nums text-[var(--text-tertiary)]" aria-live="polite">{Math.round(zoom * 100)}%</span>
        <IconButton label="Zoom in" size="sm" onClick={() => step(1)} disabled={zoomIdx === ZOOMS.length - 1}><ZoomIn size={13} /></IconButton>
        <IconButton label="Fit to view" size="sm" onClick={fit}><Maximize2 size={12} /></IconButton>
      </div>
    </div>
  );

  if (mode === "people" && people.length === 0) {
    return (
      <div className="flex flex-col flex-1 min-w-0 min-h-0">
        {toolbar}
        <CanvasEmptyState message="No people yet. Add people in the People view and the reporting line shows up here." />
      </div>
    );
  }

  if (mode === "teams") {
    return (
      <div className="flex flex-col flex-1 min-w-0 min-h-0">
        {toolbar}
        {forest.length === 0 ? (
          <CanvasEmptyState message="No teams yet. Give people a team, or open Teams to start one and say which team it sits under." />
        ) : (
          <Stage
            width={teamLayout.width} height={teamLayout.height} zoom={zoom} scrollRef={scrollRef} onZoom={step}
            label={`Team chart of ${teamLayout.nodes.length} teams`}
            links={teamLayout.links.map((l) => {
              const a = teamPos.get(l.from); const b = teamPos.get(l.to);
              if (!a || !b) return null;
              return <path key={l.id} d={elbowPath(a.x + ORG_CARD_W / 2, a.y + ORG_CARD_H, b.x + ORG_CARD_W / 2, b.y)} fill="none" stroke="var(--border)" strokeWidth={1.25} />;
            })}
          >
            {teamLayout.nodes.map(({ id, node, x, y }) => {
              const g = node.group;
              const lead = g.info?.leadPersonId ? byId.get(g.info.leadPersonId) : undefined;
              const total = node.children.length ? peopleUnder(node).length : g.people.length;
              const sub = [lead ? `Lead ${lead.name}` : null, `${total} ${total === 1 ? "person" : "people"}`].filter(Boolean).join(" · ");
              const mine = me && g.people.some((p) => p.id === me.id);
              const body = (
                <>
                  <span className="block truncate font-display text-base leading-tight text-[var(--text-primary)]">{g.team}</span>
                  <span className="mt-0.5 block truncate text-2xs text-[var(--text-tertiary)]">{sub}</span>
                </>
              );
              const cls = cn(
                "absolute flex flex-col justify-center rounded-lg border px-3 text-left shadow-elev-1",
                mine ? "border-[var(--accent)] bg-[var(--accent-dim)]" : "border-[var(--border-subtle)] bg-[var(--surface-2)]",
              );
              const style = { left: x, top: y, width: ORG_CARD_W, height: ORG_CARD_H };
              return onOpenTeam ? (
                <button key={id} type="button" style={style} onClick={() => onOpenTeam(g.key)} aria-label={`${g.team}, ${sub}. Open team`}
                  className={cn(cls, "transition-shadow hover:shadow-elev-2", FOCUS_RING)}>{body}</button>
              ) : (
                <div key={id} style={style} className={cls} aria-label={`${g.team}, ${sub}`}>{body}</div>
              );
            })}
          </Stage>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col flex-1 min-w-0 min-h-0">
      {toolbar}
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
      {chart.roots.length > 0 ? (
        <Stage
          width={layout.width} height={layout.height} zoom={zoom} scrollRef={scrollRef} onZoom={step}
          label={`Org chart of ${layout.nodes.length} people in ${chart.roots.length} ${chart.roots.length === 1 ? "tree" : "trees"}`}
          links={layout.links.map((l) => {
            const a = pos.get(l.from); const b = pos.get(l.to);
            if (!a || !b) return null;
            const onLine = myLine.has(l.from) && myLine.has(l.to);
            const faded = dims(l.to);
            return (
              <path
                key={l.id} d={elbowPath(a.x + ORG_CARD_W / 2, a.y + ORG_CARD_H, b.x + ORG_CARD_W / 2, b.y)} fill="none"
                stroke={onLine ? "var(--accent)" : "var(--border)"} strokeWidth={onLine ? 2 : 1.25} opacity={faded ? 0.35 : 1}
              />
            );
          })}
        >
          {layout.nodes.map(({ id, node, x, y }) => {
            const p = node.person;
            const isMe = me?.id === id;
            const rel = p.relationship[0] ? (p.relationship[0].label || RELATIONSHIP_LABELS[p.relationship[0].type]) : "";
            const extra = node.alsoReportsTo.map((m) => byId.get(m)?.name).filter(Boolean);
            const alsoText = extra.length ? `Also reports to ${extra.join(", ")}` : "";
            const reports = node.children.length;
            // What the card shows: role and team; the accessible name keeps relationship and reports.
            const shown = [p.title || (isMe ? "You" : rel), p.team].filter(Boolean).join(" · ");
            const sub = isMe ? ["You", alsoText].filter(Boolean).join(" · ") : alsoText || rel;
            return (
              <button
                key={id} type="button"
                style={{ left: x, top: y, width: ORG_CARD_W, height: ORG_CARD_H }}
                aria-label={`${p.name}${isMe ? " (you)" : ""}${isMe ? (alsoText ? `, ${alsoText}` : "") : sub ? `, ${sub}` : ""}${reports ? `, ${reports} direct ${reports === 1 ? "report" : "reports"}` : ""}${p.team ? `, ${p.team}` : ""}${node.cycleBroken ? ", manager link cut to break a loop" : ""}. Open person`}
                title={node.cycleBroken ? "Their manager link was cut to break a loop" : undefined}
                onClick={() => open(id)}
                className={cn(
                  "absolute flex items-center gap-2.5 rounded-lg border px-2.5 text-left shadow-elev-1 transition-[box-shadow,opacity] hover:shadow-elev-2",
                  FOCUS_RING,
                  isMe ? "border-[var(--accent)] bg-[var(--accent-dim)]" : myLine.has(id) ? "border-[color-mix(in_srgb,var(--accent)_55%,var(--border))] bg-[var(--surface-2)]" : "border-[var(--border-subtle)] bg-[var(--surface-2)]",
                  dims(p.id) && "opacity-35",
                  !!hl && !dims(p.id) && !isMe && "border-[var(--text-secondary)]",
                )}
              >
                <PersonAvatar name={p.name} isMe={isMe} size="md" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-[var(--text-primary)]">{p.name}</span>
                  {(shown || alsoText) && <span className="block truncate text-2xs text-[var(--text-tertiary)]">{alsoText || shown}</span>}
                </span>
                {reports > 0 && (
                  <span className="self-start mt-2 rounded-full bg-[color-mix(in_srgb,var(--text-primary)_7%,transparent)] px-1.5 text-2xs tabular-nums text-[var(--text-tertiary)]" aria-hidden>{reports}</span>
                )}
              </button>
            );
          })}
        </Stage>
      ) : <div className="flex-1" />}

      {chart.unplaced.length > 0 && (
        <div className="px-3 pb-3 pt-1 border-t border-[var(--border-subtle)] flex-shrink-0">
          <p className="py-1.5 text-xs text-[var(--text-tertiary)]">Not in a reporting line ({chart.unplaced.length})</p>
          <ul className="flex flex-wrap gap-1.5 max-h-40 overflow-auto">
            {chart.unplaced.map((p) => (
              <li key={p.id}>
                <button
                  type="button" onClick={() => open(p.id)}
                  className={cn("inline-flex items-center gap-1.5 rounded-full border border-[var(--border-subtle)] py-0.5 pl-0.5 pr-2.5 text-xs text-[var(--text-secondary)] hover:bg-[var(--surface-2)]", FOCUS_RING, dims(p.id) && "opacity-40")}
                >
                  <PersonAvatar name={p.name} isMe={p.isMe} size="xs" />{p.name}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
