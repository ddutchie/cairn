"use client";

/**
 * People view, "Map": where everyone is, with the night side shaded, so you can
 * tell who is probably offline. People are placed from their time zone (the
 * zone's principal city, see `ZONE_COORDS`); the slider moves time forward or
 * back to answer "who is online at 3pm tomorrow". Status is a dot and a word.
 */
import React, { useMemo, useState } from "react";
import * as d3 from "d3";
import { Globe } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { PeopleCanvasPage } from "./PeopleCanvasPage";
import { PanelHeading } from "@/components/ui/panel";
import { StatusDot } from "@/components/ui/status-dot";
import { Button, FOCUS_RING } from "@/components/ui/button";
import { OpenPersonContext } from "@/components/graph/peopleCanvasShared";
import { useFontScale, useNow } from "@/lib/viz/hooks";
import { findMe } from "@/lib/people/network";
import land from "@/lib/people/land-110m.json";
import { cn } from "@/lib/utils";
import "../../../shared/people/place-data";
import { placeInfo } from "../../../shared/people/place-zone";
import { ZONE_COORDS } from "../../../shared/people/zone-coords";
import { sunAt } from "../../../shared/people/sun";
import { availabilityAt, localHourAt, systemZone, zoneOffsetMinutes, type Availability } from "../../../shared/people/zones";
import type { PersonSummary } from "../../../shared/types/people-view";

const W = 960;
const H = 500;
const COLOR: Record<Availability, string> = { work: "var(--success)", edge: "var(--warning)", asleep: "var(--text-tertiary)" };
const WORDS: Record<Availability, string> = { work: "At work", edge: "Early or late", asleep: "Probably asleep" };

const hhmm = (h: number) => `${String(Math.floor(h)).padStart(2, "0")}:${String(Math.floor((h % 1) * 60)).padStart(2, "0")}`;
const cityOf = (tz: string) => tz.split("/").pop()!.replace(/_/g, " ");

/** People who share a spot on the map: the same city when their location names one in their zone, else the zone's principal city. */
interface Group { key: string; label: string; tz: string; lat: number; lon: number; people: PersonSummary[] }

/** Where a person goes on the map: their own city when it lies in their time zone, else the zone's principal city. */
function spotOf(p: PersonSummary): { key: string; label: string; lat: number; lon: number } | null {
  if (!p.timezone) return null;
  const zone = ZONE_COORDS[p.timezone];
  const here = p.location ? placeInfo(p.location) : null;
  // The location only counts when it agrees with the time zone: a stale city must not move someone to the wrong side of the world.
  if (here?.coords && zoneOffsetMinutes(p.timezone, new Date()) === zoneOffsetMinutes(here.zone, new Date())) {
    const [lat, lon] = here.coords;
    return { key: `${p.timezone}|${lat.toFixed(1)},${lon.toFixed(1)}`, label: p.location!.split(",")[0].trim(), lat, lon };
  }
  return zone ? { key: p.timezone, label: cityOf(p.timezone), lat: zone[0], lon: zone[1] } : null;
}

export function MapCanvas({ people, selectedId }: { people: readonly PersonSummary[]; selectedId?: string | null }) {
  const fs = useFontScale();
  const open = React.useContext(OpenPersonContext);
  const now = useNow(60_000);
  const [offset, setOffset] = useState(0);
  const [zone, setZone] = useState<string | null>(null);
  const t = new Date(now + offset * 3_600_000);

  const projection = useMemo(() => d3.geoNaturalEarth1().fitSize([W, H], { type: "Sphere" }), []);
  const path = useMemo(() => d3.geoPath(projection), [projection]);
  const { groups, unplaced } = useMemo(() => {
    const map = new Map<string, Group>();
    const out: PersonSummary[] = [];
    for (const p of people) {
      const spot = spotOf(p);
      if (!p.timezone || !spot || zoneOffsetMinutes(p.timezone, new Date()) === null) { out.push(p); continue; }
      const g = map.get(spot.key) ?? { ...spot, tz: p.timezone, people: [] };
      g.people.push(p);
      map.set(spot.key, g);
    }
    return { groups: [...map.values()], unplaced: out.sort((a, b) => a.name.localeCompare(b.name)) };
  }, [people]);

  if (people.length === 0) return <EmptyState icon={Globe} title="No people yet" description="Add the people you work with and where they are shows up here." className="h-full" />;

  const sun = sunAt(t);
  const night = path(d3.geoCircle().center([sun.lon + 180, -sun.lat]).radius(90)()) ?? "";
  const sunPt = projection([sun.lon, sun.lat]);
  const me = findMe(people);
  const myZone = me?.timezone && zoneOffsetMinutes(me.timezone, t) !== null ? me.timezone : systemZone();
  const when = new Intl.DateTimeFormat("en-GB", { timeZone: myZone, weekday: "short", hour: "2-digit", minute: "2-digit" }).format(t);
  const availOf = (g: Group): Availability => availabilityAt(localHourAt(g.tz, t) ?? 12);
  const sel = zone ? groups.find((g) => g.key === zone) : undefined;
  const selHour = sel ? localHourAt(sel.tz, t) ?? 0 : 0;
  const font = 10 * fs;

  return (
    <PeopleCanvasPage lede="Where everyone is right now, with the night drawn in, so you can tell who is probably offline.">
      <section aria-label="Around the world">
        <PanelHeading title="Around the world" note={`${offset === 0 ? "Now" : `${offset > 0 ? "+" : ""}${offset}h`}, ${when} in ${cityOf(myZone)}`} />
        <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 shadow-elev-1">
          <div className="mb-3 flex flex-wrap items-center gap-3">
            <Button size="xs" variant="outline" onClick={() => setOffset(0)} disabled={offset === 0}>Now</Button>
            <input
              type="range" min={-24} max={24} step={0.5} value={offset} onChange={(e) => setOffset(Number(e.target.value))}
              aria-label="Hours from now" className="w-72 max-w-full accent-[var(--accent)]"
            />
            <span className="text-xs text-[var(--text-tertiary)]">Slide to see who is online later or earlier</span>
          </div>
          <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="group" aria-label="World map with day and night">
            <path d={path({ type: "Sphere" }) ?? ""} fill="var(--surface)" stroke="var(--border)" />
            <path d={path(d3.geoGraticule10()) ?? ""} fill="none" stroke="var(--border)" strokeWidth={0.4} opacity={0.6} />
            <path d={path(land as unknown as d3.GeoPermissibleObjects) ?? ""} fill="color-mix(in srgb, var(--text-primary) 13%, var(--surface))" />
            <path d={night} fill="color-mix(in srgb, var(--text-primary) 16%, transparent)" pointerEvents="none" />
            {sunPt && (
              <g transform={`translate(${sunPt[0]},${sunPt[1]})`} pointerEvents="none" aria-hidden>
                <circle r={8} fill="var(--surface)" stroke="var(--warning)" strokeWidth={2} />
                <circle r={3} fill="var(--warning)" />
              </g>
            )}
            {groups.map((g) => {
              const pt = projection([g.lon, g.lat]);
              if (!pt) return null;
              const a = availOf(g);
              const on = zone === g.key || g.people.some((p) => p.id === selectedId);
              return (
                <g
                  key={g.key} transform={`translate(${pt[0]},${pt[1]})`} role="button" tabIndex={0}
                  aria-label={`${g.label}, ${g.people.length} ${g.people.length === 1 ? "person" : "people"}, ${WORDS[a].toLowerCase()}`}
                  className="cursor-pointer outline-none [&:focus-visible>circle]:stroke-[var(--accent)]"
                  onClick={() => setZone(g.key)}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setZone(g.key); } }}
                >
                  <circle r={g.people.length > 1 ? 10 : 7} fill={COLOR[a]} stroke={on ? "var(--text-primary)" : "var(--surface)"} strokeWidth={2} />
                  {g.people.length > 1 && <text textAnchor="middle" dy="0.34em" fontSize={font} fill="var(--surface)" pointerEvents="none">{g.people.length}</text>}
                  <title>{g.label}</title>
                </g>
              );
            })}
          </svg>
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-[var(--text-secondary)]">
            {(["work", "edge", "asleep"] as const).map((k) => (
              <span key={k} className="inline-flex items-center gap-1.5"><StatusDot color={COLOR[k]} />{k === "work" ? "At work, 9 to 17 local" : k === "edge" ? "Early or late" : "Probably asleep, 22 to 07"}</span>
            ))}
            <span>Shaded area is night. The sun marks where it is overhead.</span>
          </div>
        </div>
      </section>

      <section aria-label="Who is there" className="mt-9">
        <PanelHeading title="Who is there" />
        {sel ? (
          <div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-2)] p-3 shadow-elev-1">
            <p className="text-2xs text-[var(--text-tertiary)]">{sel.label}, {hhmm(selHour)} local</p>
            <p className="mt-0.5 mb-1.5 inline-flex items-center gap-1.5 text-sm" style={{ color: COLOR[availOf(sel)] }}>
              <StatusDot color={COLOR[availOf(sel)]} />{WORDS[availOf(sel)]}
            </p>
            <ul className="flex flex-wrap gap-1">
              {sel.people.map((p) => (
                <li key={p.id}>
                  <button
                    type="button" onClick={() => open?.(p.id)} aria-pressed={p.id === selectedId}
                    className={cn("rounded border border-[var(--border-subtle)] bg-[var(--surface)] px-1.5 py-0.5 text-xs text-[var(--text-secondary)] hover:bg-[var(--surface-3)]", FOCUS_RING, p.id === selectedId && "border-[var(--accent)] text-[var(--accent)]")}
                  >
                    {p.name}{p.isMe ? " (you)" : ""}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <p className="text-xs text-[var(--text-tertiary)]">Choose a marker on the map.</p>
        )}
      </section>

      {unplaced.length > 0 && (
        <section aria-label="Not on the map" className="mt-9">
          <PanelHeading title="Not on the map" note={String(unplaced.length)} />
          <ul className="flex flex-wrap gap-1.5">
            {unplaced.map((p) => (
              <li key={p.id}><button type="button" onClick={() => open?.(p.id)} className={cn("rounded border border-[var(--border-subtle)] px-2 py-1 text-xs text-[var(--text-secondary)] hover:bg-[var(--surface-2)]", FOCUS_RING)}>{p.name}</button></li>
            ))}
          </ul>
          <p className="mt-2 text-2xs text-[var(--text-tertiary)]">Set a time zone on their page, for example Europe/London, to place them.</p>
        </section>
      )}
    </PeopleCanvasPage>
  );
}
