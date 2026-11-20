/**
 * The city data behind `place-zone.ts`: the `city-timezones` dataset (about
 * 7,300 cities with their time zone, position and population), indexed by
 * name. Importing this file registers the resolver. Desktop and the MCP runtime
 * import it; mobile does not (see `place-zone.ts`).
 *
 * A place is "City, State, Country" in any common spelling. The city part is
 * looked up and the rest narrow it ("Portland, ME", "London, Ontario"); with no
 * narrowing the most populous city of that name wins (San Francisco is the
 * Californian one). When the city is unknown, a state, province or country
 * that lies in one time zone resolves to it ("Germany", "Texas").
 */

import { cityMapping } from "city-timezones";
import { registerPlaceResolver, registerPlaceSearch, type PlaceInfo, type PlaceMatch } from "./place-zone";
import { ZONE_COORDS } from "./zone-coords";

interface Entry {
  city: string;
  province: string;
  /** Lower-case ISO country code. */
  iso2: string;
  country: string;
  state: string;
  zone: string;
  lat: number;
  lon: number;
  pop: number;
  /** How the place reads in a suggestion: "San Francisco, California, US". */
  label: string;
}

/** Dataset cells are strings, but a few rows carry numbers or nulls. */
const str = (v: unknown): string => (typeof v === "string" ? v : "");

const fold = (s: string) =>
  s.normalize("NFKD").replace(/\p{M}+/gu, "").toLowerCase().replace(/[.']/g, "").replace(/[^a-z0-9, ]+/g, " ").replace(/\s+/g, " ").trim();

/** The zone name the map and `Intl` agree on (the dataset carries retired names like America/Montreal). */
function canonicalZone(tz: string | null | undefined): string | null {
  if (!tz) return null;
  if (ZONE_COORDS[tz]) return tz;
  try {
    const resolved = new Intl.DateTimeFormat("en", { timeZone: tz }).resolvedOptions().timeZone;
    return ZONE_COORDS[resolved] ? resolved : resolved || tz;
  } catch {
    return null;
  }
}

const CA_PROVINCE_ABBR: Record<string, string> = {
  ab: "alberta", bc: "british columbia", mb: "manitoba", nb: "new brunswick", nl: "newfoundland and labrador", ns: "nova scotia",
  on: "ontario", pe: "prince edward island", qc: "quebec", sk: "saskatchewan", nt: "northwest territories", nu: "nunavut", yt: "yukon",
};
/** Ways people write a country that the dataset spells differently. */
const COUNTRY_ALIAS: Record<string, string> = {
  usa: "us", "united states": "us", "united states of america": "us", america: "us",
  uk: "gb", "united kingdom": "gb", england: "gb", scotland: "gb", wales: "gb", "northern ireland": "gb", "great britain": "gb",
  uae: "ae", holland: "nl", "the netherlands": "nl", "south korea": "kr", korea: "kr", czechia: "cz", turkiye: "tr", nz: "nz",
};
/** Metro names and abbreviations that are not a city in the dataset. */
const PLACE_ALIAS: Record<string, string> = {
  sf: "san francisco", "sf bay": "san francisco", "bay area": "san francisco", "sf bay area": "san francisco", "san francisco bay area": "san francisco",
  "silicon valley": "san jose", nyc: "new york", "new york city": "new york", la: "los angeles", dc: "washington", "washington dc": "washington", "washington d c": "washington",
  philly: "philadelphia", bombay: "mumbai", saigon: "ho chi minh city", cdmx: "mexico city",
};
const NOISE = /\b(greater|area|metro|metropolitan|region|remote|based|near)\b/g;

const entries: Entry[] = [];
const byCity = new Map<string, Entry[]>();
const byRegion = new Map<string, Entry[]>();
const push = (m: Map<string, Entry[]>, k: string, e: Entry) => { const a = m.get(k); if (a) a.push(e); else m.set(k, [e]); };

for (const c of cityMapping) {
  const zone = canonicalZone(c.timezone);
  if (!zone || !str(c.city)) continue;
  const e: Entry = {
    city: fold(str(c.city_ascii) || str(c.city)), province: fold(str(c.province)), iso2: str(c.iso2).toLowerCase(),
    country: fold(str(c.country)), state: str(c.state_ansi).toLowerCase(), zone, lat: Number(c.lat), lon: Number(c.lng), pop: Number(c.pop) || 0,
    label: [str(c.city), str(c.province) !== str(c.city) ? str(c.province) : "", str(c.iso2)].filter(Boolean).join(", "),
  };
  entries.push(e);
  push(byCity, e.city, e);
  const native = fold(str(c.city));
  if (native !== e.city) push(byCity, native, e);
  if (e.province) push(byRegion, e.province, e);
  if (e.country) push(byRegion, e.country, e);
}

const matches = (e: Entry, hint: string): boolean => {
  const h = COUNTRY_ALIAS[hint] ?? hint;
  if (h === e.province || h === e.country || h === e.iso2) return true;
  if (e.iso2 === "us" && h === e.state) return true;
  return e.iso2 === "ca" && CA_PROVINCE_ABBR[h] === e.province;
};

const biggest = (list: readonly Entry[]) => list.reduce((a, b) => (b.pop > a.pop ? b : a));

function cityLookup(city: string, hints: readonly string[], strict = false): PlaceInfo | null {
  const found = byCity.get(PLACE_ALIAS[city] ?? city) ?? byCity.get((PLACE_ALIAS[city] ?? city).replace(NOISE, " ").replace(/\s+/g, " ").trim());
  if (!found) return null;
  let pool: readonly Entry[] = found;
  if (hints.length) {
    const all = found.filter((e) => hints.every((h) => matches(e, h)));
    const some = all.length ? all : found.filter((e) => hints.some((h) => matches(e, h)));
    if (some.length) pool = some;
    // A guessed split ("Berlin time" as city "Berlin" + hint "time") must be confirmed by the hint.
    else if (strict) return null;
  }
  const e = biggest(pool);
  return { zone: e.zone, coords: [e.lat, e.lon] };
}

/** Share of a region's (listed) population one zone must hold for the region to resolve to it. */
const DOMINANT = 0.9;

/** A state, province or country that lies (all but a sliver of it) in one zone: Germany, Texas. Not the US, Canada or Brazil. */
function regionLookup(name: string): PlaceInfo | null {
  const key = COUNTRY_ALIAS[name];
  const list = key ? entries.filter((e) => e.iso2 === key) : byRegion.get(name);
  if (!list?.length) return null;
  const byZone = new Map<string, number>();
  let total = 0;
  for (const e of list) { const w = e.pop + 1; byZone.set(e.zone, (byZone.get(e.zone) ?? 0) + w); total += w; }
  const [zone, weight] = [...byZone].sort((a, b) => b[1] - a[1])[0];
  return weight / total >= DOMINANT ? { zone } : null;
}

function resolve(place: string): PlaceInfo | null {
  const parts = fold(place).split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  // "San Francisco CA" with no comma: the last word may be a state or country code.
  const words = parts[0].split(" ");
  const loose = parts.length === 1 && words.length > 1 ? { city: words.slice(0, -1).join(" "), hint: words[words.length - 1] } : null;
  for (let i = 0; i < parts.length; i++) {
    const hints = parts.filter((_, j) => j !== i);
    const hit = cityLookup(parts[i], hints);
    if (hit) return hit;
  }
  if (loose) {
    const hit = cityLookup(loose.city, [loose.hint], true);
    if (hit) return hit;
  }
  for (const part of parts) {
    const hit = regionLookup(part) ?? regionLookup(part.replace(NOISE, " ").replace(/\s+/g, " ").trim());
    if (hit) return hit;
  }
  return null;
}

/** Most populous first, so the first suggestions for "san" are cities people have heard of. */
const byPopulation = [...entries].sort((a, b) => b.pop - a.pop);

/** "City" or "City, State/Country" prefixes: "san fr", "portland, or", "paris, fr". */
function search(query: string, limit: number): PlaceMatch[] {
  const [first, ...rest] = fold(query).split(",").map((p) => p.trim()).filter(Boolean);
  if (!first) return [];
  const city = PLACE_ALIAS[first] ?? first;
  const out: PlaceMatch[] = [];
  const seen = new Set<string>();
  for (const e of byPopulation) {
    if (!e.city.startsWith(city)) continue;
    if (rest.length && !rest.every((h) => matches(e, h) || e.province.startsWith(h) || e.country.startsWith(h))) continue;
    if (seen.has(e.label)) continue;
    seen.add(e.label);
    out.push({ label: e.label, zone: e.zone, coords: [e.lat, e.lon] });
    if (out.length >= limit) break;
  }
  return out;
}

registerPlaceResolver(resolve);
registerPlaceSearch(search);
