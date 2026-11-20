/**
 * From a place as someone writes it ("San Francisco, CA", "Montréal") to its
 * IANA time zone, so a location can fill the time zone and put the person on
 * the map. IANA has no zone for most cities (Montreal is America/Toronto), so
 * typing a city into the time zone box used to fail.
 *
 * This file is the portable part (mobile imports `shared/people`): a plug-in
 * point and the helpers built on it. The city data (`city-timezones`, ~2 MB) is
 * in `place-data.ts`, which registers itself when imported; desktop and the MCP
 * runtime import it, mobile does not, and without it every lookup returns null.
 */

import { cleanProfileField, type ProfileField } from "./parse";

export interface PlaceInfo {
  /** IANA time zone of the place. */
  zone: string;
  /** Where the place is, when it names one city (a country or state has no single point). */
  coords?: readonly [lat: number, lon: number];
}

type PlaceResolver = (place: string) => PlaceInfo | null;
let resolver: PlaceResolver | null = null;

/** Called by `place-data.ts`; the last registration wins. */
export function registerPlaceResolver(r: PlaceResolver | null): void {
  resolver = r;
}

export function placeInfo(place: string | null | undefined): PlaceInfo | null {
  const text = place?.trim();
  return text && resolver ? resolver(text) : null;
}

export function zoneForPlace(place: string | null | undefined): string | null {
  return placeInfo(place)?.zone ?? null;
}

/**
 * `cleanProfileField`, except a place name is accepted as a time zone and
 * stored as its zone ("Montreal" gives America/Toronto).
 */
export function cleanProfileFieldWithPlaces(field: ProfileField, raw: unknown): { value?: string; error?: string } {
  const out = cleanProfileField(field, raw);
  if (field !== "timezone" || !out.error || typeof raw !== "string") return out;
  const zone = zoneForPlace(raw);
  return zone ? { value: zone } : { error: `"${raw.trim()}" isn't a time zone. Use an IANA name like Europe/Berlin, or a city.` };
}

/** A suggestion for a place being typed. */
export interface PlaceMatch {
  /** "San Francisco, California, US". */
  label: string;
  zone: string;
  coords: readonly [lat: number, lon: number];
}

type PlaceSearch = (query: string, limit: number) => PlaceMatch[];
let search: PlaceSearch | null = null;

/** Called by `place-data.ts`. */
export function registerPlaceSearch(fn: PlaceSearch | null): void {
  search = fn;
}

/** Cities that start with what has been typed, biggest first ("san fr" gives San Francisco). Empty without the city data. */
export function searchPlaces(query: string, limit = 8): PlaceMatch[] {
  const q = query.trim();
  return q.length >= 2 && search ? search(q, limit) : [];
}

const fold = (s: string) => s.normalize("NFKD").replace(/\p{M}+/gu, "").toLowerCase().replace(/[_/]+/g, " ").replace(/\s+/g, " ").trim();
let zoneNames: string[] | null = null;

/** IANA zone names matching what has been typed, the last part (the city) first: "los" gives America/Los_Angeles. */
export function searchZones(query: string, limit = 8): string[] {
  const q = fold(query);
  if (q.length < 2) return [];
  if (!zoneNames) {
    try {
      zoneNames = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone") ?? [];
    } catch {
      zoneNames = [];
    }
  }
  const starts: string[] = [], contains: string[] = [];
  for (const z of zoneNames) {
    const full = fold(z), city = fold(z.split("/").pop() ?? z);
    if (city.startsWith(q) || full.startsWith(q)) starts.push(z);
    else if (full.includes(q)) contains.push(z);
  }
  return [...starts, ...contains].slice(0, limit);
}
