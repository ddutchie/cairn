/**
 * Where the sun is, to the accuracy a world map needs (NOAA's low-precision
 * formulae, about a degree). Used by the People map to shade the night side
 * and to say whether the sun is up where someone is.
 */

const RAD = Math.PI / 180;
const DAY_MS = 86_400_000;

export interface SunPosition {
  /** Latitude and longitude of the point where the sun is straight overhead, in degrees. */
  lat: number;
  lon: number;
  /** Internals for `sunElevation`. */
  dec: number;
  ra: number;
  gmstHours: number;
}

export function sunAt(at: Date | number): SunPosition {
  const t = typeof at === "number" ? at : at.getTime();
  const n = t / DAY_MS + 2440587.5 - 2451545.0;
  const L = (((280.46 + 0.9856474 * n) % 360) + 360) % 360;
  const g = ((((357.528 + 0.9856003 * n) % 360) + 360) % 360) * RAD;
  const lambda = (L + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * RAD;
  const eps = (23.439 - 4e-7 * n) * RAD;
  const dec = Math.asin(Math.sin(eps) * Math.sin(lambda));
  const ra = Math.atan2(Math.cos(eps) * Math.sin(lambda), Math.cos(lambda));
  const gmstHours = (((18.697374558 + 24.06570982441908 * n) % 24) + 24) % 24;
  const lon = ((((ra / RAD - gmstHours * 15) % 360) + 540) % 360) - 180;
  return { lat: dec / RAD, lon, dec, ra, gmstHours };
}

/** Degrees above the horizon at a place (negative below it). */
export function sunElevation(sun: SunPosition, lat: number, lon: number): number {
  const hourAngle = (sun.gmstHours * 15 + lon) * RAD - sun.ra;
  return Math.asin(Math.sin(lat * RAD) * Math.sin(sun.dec) + Math.cos(lat * RAD) * Math.cos(sun.dec) * Math.cos(hourAngle)) / RAD;
}
