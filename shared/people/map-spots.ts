/**
 * Where people go on the People map, shared by desktop (D3 SVG) and mobile
 * (Skia): a person lands on their own city when it lies in their time zone,
 * else on the zone's principal city. People who share a spot form one group.
 */
import "./place-data";
import { placeInfo } from "./place-zone";
import { ZONE_COORDS } from "./zone-coords";
import { sameZone, zoneOffsetMinutes } from "./zones";
import type { PersonSummary } from "../types/people-view";

export interface MapGroup { key: string; label: string; tz: string; lat: number; lon: number; people: PersonSummary[] }

export const cityOf = (tz: string): string => tz.split("/").pop()!.replace(/_/g, " ");

/** Where a person goes on the map, or null when they have no placeable time zone. */
export function spotOf(p: PersonSummary): { key: string; label: string; lat: number; lon: number } | null {
  if (!p.timezone) return null;
  const zone = ZONE_COORDS[p.timezone];
  const here = p.location ? placeInfo(p.location) : null;
  // The location only counts when it agrees with the time zone: a stale city must not move someone to the wrong side of the world.
  if (here?.coords && sameZone(p.timezone, here.zone)) {
    const [lat, lon] = here.coords;
    return { key: `${p.timezone}|${lat.toFixed(1)},${lon.toFixed(1)}`, label: p.location!.split(",")[0].trim(), lat, lon };
  }
  return zone ? { key: p.timezone, label: cityOf(p.timezone), lat: zone[0], lon: zone[1] } : null;
}

/** People grouped by spot; `unplaced` are those with no usable zone, by name. */
export function groupBySpot(people: readonly PersonSummary[], now: Date = new Date()): { groups: MapGroup[]; unplaced: PersonSummary[] } {
  const map = new Map<string, MapGroup>();
  const unplaced: PersonSummary[] = [];
  for (const p of people) {
    const spot = spotOf(p);
    if (!p.timezone || !spot || zoneOffsetMinutes(p.timezone, now) === null) { unplaced.push(p); continue; }
    const g = map.get(spot.key) ?? { ...spot, tz: p.timezone, people: [] };
    g.people.push(p);
    map.set(spot.key, g);
  }
  return { groups: [...map.values()], unplaced: unplaced.sort((a, b) => a.name.localeCompare(b.name)) };
}
