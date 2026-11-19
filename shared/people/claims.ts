/**
 * Per-source claims on an attendee row (`meeting_attendees.sources`).
 *
 * Each source (calendar, frontmatter, …) that lists a person holds a claim
 * `{ on, at }`: `on` true while it lists them, false once it dropped them, `at`
 * when that last changed. Claims merge per source by the later `at` (a tie
 * keeps `on`), so a removal made on one device survives a sync with a device
 * that still has the old claim, and two devices adding different sources both
 * stay. Pure, so desktop, the sync engine and mobile share one copy.
 */

export interface Claim {
  on: boolean;
  at: string;
}
export type Claims = Record<string, Claim>;

/** Parse the stored value. A legacy array of source names counts as claims made at the epoch. */
export function parseClaims(raw: unknown): Claims {
  let v: unknown = raw;
  if (typeof raw === "string") {
    try { v = JSON.parse(raw); } catch { return {}; }
  }
  const out: Claims = {};
  if (Array.isArray(v)) {
    for (const s of v) if (typeof s === "string") out[s] = { on: true, at: "" };
    return out;
  }
  if (v && typeof v === "object") {
    for (const [k, c] of Object.entries(v as Record<string, unknown>)) {
      if (c && typeof c === "object" && typeof (c as Claim).at === "string") {
        out[k] = { on: (c as Claim).on === true, at: (c as Claim).at };
      }
    }
  }
  return out;
}

export function serializeClaims(claims: Claims): string {
  return JSON.stringify(claims);
}

/** Sources whose claim is on. */
export function activeSources(claims: Claims): string[] {
  return Object.keys(claims).filter((k) => claims[k].on);
}

/** Per-source merge: the later claim wins; on a tie, "on" wins. */
export function mergeClaims(a: unknown, b: unknown): string {
  const left = parseClaims(a);
  const right = parseClaims(b);
  const out: Claims = { ...left };
  for (const [k, c] of Object.entries(right)) {
    const mine = out[k];
    if (!mine || c.at > mine.at || (c.at === mine.at && c.on && !mine.on)) out[k] = c;
  }
  return serializeClaims(out);
}

/** True when `merged` holds a claim the `remote` value doesn't (so it must be sent back). */
export function claimsDifferFrom(merged: unknown, remote: unknown): boolean {
  const m = parseClaims(merged);
  const r = parseClaims(remote);
  return Object.entries(m).some(([k, c]) => !r[k] || r[k].at !== c.at || r[k].on !== c.on);
}
