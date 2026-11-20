/**
 * People grouped by the team you recorded for them (People view, "Teams").
 * Pure: the view only draws what this returns.
 */
import type { RelationshipType } from "../types/people";
import type { PersonSummary } from "../types/people-view";

export const NO_TEAM = "No team";

export interface TeamGroup {
  /** Display name; `NO_TEAM` for people without one. */
  team: string;
  people: PersonSummary[];
  /** How many of them hold each relationship to you (someone with two counts in both). */
  byRelationship: Partial<Record<RelationshipType, number>>;
  /** Distinct time zones in the team, for a quick "spread across" hint. */
  timezones: string[];
}

const norm = (t: string | undefined): string => (t ?? "").trim().replace(/\s+/g, " ");

/** Teams largest first, then by name; people with no team last. Team names match ignoring case. */
export function groupByTeam(people: readonly PersonSummary[]): TeamGroup[] {
  const map = new Map<string, TeamGroup>();
  for (const p of people) {
    const name = norm(p.team);
    const key = name.toLowerCase();
    let g = map.get(key);
    if (!g) {
      g = { team: name || NO_TEAM, people: [], byRelationship: {}, timezones: [] };
      map.set(key, g);
    }
    g.people.push(p);
    for (const r of new Set(p.relationship.map((x) => x.type))) g.byRelationship[r] = (g.byRelationship[r] ?? 0) + 1;
    if (p.timezone && !g.timezones.includes(p.timezone)) g.timezones.push(p.timezone);
  }
  for (const g of map.values()) g.people.sort((a, b) => a.name.localeCompare(b.name));
  return [...map.values()].sort((a, b) => {
    if ((a.team === NO_TEAM) !== (b.team === NO_TEAM)) return a.team === NO_TEAM ? 1 : -1;
    return b.people.length - a.people.length || a.team.localeCompare(b.team);
  });
}
