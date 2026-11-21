/**
 * Ways to group the People list: by relationship to you (the default, see
 * `groupPeople`), by team, by where they are, by when you last met, or one
 * flat A–Z list. Pure, so desktop and mobile group the same way.
 */
import type { PersonSummary } from "../types/people-view";
import { groupPeople, matchesPersonQuery, type PeopleGroupKey } from "./model";
import { zoneOffsetMinutes } from "./zones";

export const LIST_GROUPINGS = [
  { value: "relationship", label: "Relationship" },
  { value: "team", label: "Team" },
  { value: "place", label: "Location" },
  { value: "recency", label: "Last met" },
  { value: "name", label: "Name" },
] as const;
export type ListGrouping = (typeof LIST_GROUPINGS)[number]["value"];

export interface ListGroup {
  key: string;
  label: string;
  /** A quiet line beside the label: local time for a place, nothing otherwise. */
  note?: string;
  people: PersonSummary[];
}

const byName = (a: PersonSummary, b: PersonSummary) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
const norm = (s: string | undefined) => (s ?? "").trim().replace(/\s+/g, " ");
const cityOf = (tz: string) => tz.split("/").pop()!.replace(/_/g, " ");

function bucket(people: readonly PersonSummary[], keyOf: (p: PersonSummary) => { key: string; label: string } | null, fallback: string): Map<string, ListGroup> {
  const map = new Map<string, ListGroup>();
  for (const p of people) {
    const k = keyOf(p) ?? { key: "", label: fallback };
    const g = map.get(k.key) ?? { key: k.key || "_none", label: k.label, people: [] };
    g.people.push(p);
    map.set(k.key, g);
  }
  for (const g of map.values()) g.people.sort(byName);
  return map;
}

/** Biggest groups first, then by label; the "none" group last. */
function ordered(map: Map<string, ListGroup>): ListGroup[] {
  return [...map.values()].sort((a, b) => {
    if ((a.key === "_none") !== (b.key === "_none")) return a.key === "_none" ? 1 : -1;
    return b.people.length - a.people.length || a.label.localeCompare(b.label);
  });
}

const RECENCY = [
  { key: "week", label: "This week", days: 7 },
  { key: "month", label: "This month", days: 31 },
  { key: "quarter", label: "Last three months", days: 92 },
  { key: "older", label: "Longer ago", days: Infinity },
] as const;

/** "HH:MM" in a zone, or undefined for an unknown zone. */
function localTime(tz: string, at: Date): string | undefined {
  if (zoneOffsetMinutes(tz, at) === null) return undefined;
  return new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit" }).format(at);
}

/**
 * Group the list, with you pinned in a "You" group at the top (when you match
 * the search and filter) and left out of the rest. `relationship` keeps its
 * fixed order and lists someone in every group they belong to; the other
 * groupings put each person once.
 */
export function groupPeopleBy(
  people: readonly PersonSummary[],
  by: ListGrouping,
  opts: { query?: string; only?: PeopleGroupKey | null; now?: Date } = {},
): ListGroup[] {
  const me = people.find((p) => p.isMe);
  if (!me) return groupOthers(people, by, opts);
  const groups = groupOthers(people.filter((p) => p !== me), by, opts);
  // You have no relationship to yourself, so the relationship filter never hides you; the search can.
  const showMe = !opts.only && (!opts.query || matchesPersonQuery(me, opts.query));
  return showMe ? [{ key: "me", label: "You", people: [me] }, ...groups] : groups;
}

function groupOthers(
  people: readonly PersonSummary[],
  by: ListGrouping,
  opts: { query?: string; only?: PeopleGroupKey | null; now?: Date } = {},
): ListGroup[] {
  if (by === "relationship") return groupPeople(people, { query: opts.query, only: opts.only });
  const now = opts.now ?? new Date();
  // Apply the same relationship filter the default grouping does.
  const only = opts.only ? new Set(groupPeople(people, { only: opts.only }).flatMap((g) => g.people.map((p) => p.id))) : null;
  const list = people.filter((p) => (!opts.query || matchesPersonQuery(p, opts.query)) && (!only || only.has(p.id)));

  switch (by) {
    case "team":
      // Keyed by the home team's id, so two teams with one name stay two groups.
      return ordered(bucket(list, (p) => {
        const home = p.teams?.[0];
        const name = norm(home?.name ?? p.team);
        return name ? { key: home?.teamId ?? name.toLowerCase(), label: name } : null;
      }, "No team"));
    case "place": {
      const groups = ordered(bucket(list, (p) => {
        if (p.timezone) return { key: p.timezone, label: cityOf(p.timezone) };
        if (norm(p.location)) return { key: `loc:${norm(p.location).toLowerCase()}`, label: norm(p.location).split(",")[0] };
        return null;
      }, "Unknown"));
      for (const g of groups) if (g.key !== "_none" && !g.key.startsWith("loc:")) g.note = localTime(g.key, now);
      return groups;
    }
    case "recency": {
      const map = bucket(list, (p) => {
        if (!p.lastMetAt) return null;
        const days = (now.getTime() - Date.parse(p.lastMetAt)) / 86_400_000;
        const r = RECENCY.find((x) => days <= x.days)!;
        return { key: r.key, label: r.label };
      }, "Not met yet");
      // Recency reads in time order, and within a group the most recent first.
      for (const g of map.values()) g.people.sort((a, b) => (b.lastMetAt ?? "").localeCompare(a.lastMetAt ?? "") || byName(a, b));
      return [...RECENCY.map((r) => map.get(r.key)), map.get("")].filter((g): g is ListGroup => !!g);
    }
    case "name": {
      const map = bucket(list, (p) => {
        const c = p.name.trim().normalize("NFKD")[0]?.toUpperCase() ?? "";
        return /[A-Z]/.test(c) ? { key: c, label: c } : { key: "#", label: "#" };
      }, "#");
      return [...map.values()].sort((a, b) => (a.key === "#" ? 1 : b.key === "#" ? -1 : a.key.localeCompare(b.key)));
    }
  }
}
