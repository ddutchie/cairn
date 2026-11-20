/**
 * People grouped by the team you recorded for them (People view, "Teams").
 * Pure: the view only draws what this returns.
 */
import type { RelationshipType, Team } from "../types/people";
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
  /** The team's details, when it has a `teams` row. */
  info?: Team;
}

const norm = (t: string | undefined): string => (t ?? "").trim().replace(/\s+/g, " ");

/**
 * Teams largest first, then by name; people with no team last. Team names
 * match ignoring case. `teams` adds each team's details, and a team with
 * details but nobody on it yet is listed too (empty).
 */
export function groupByTeam(people: readonly PersonSummary[], teams: readonly Team[] = []): TeamGroup[] {
  const map = new Map<string, TeamGroup>();
  for (const t of teams) {
    const name = norm(t.name);
    if (!name) continue;
    const key = name.toLowerCase();
    if (!map.has(key)) map.set(key, { team: name, people: [], byRelationship: {}, timezones: [], info: t });
  }
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

/** A team in its place in the team tree. */
export interface TeamNode {
  group: TeamGroup;
  /** Ancestor names, outermost first. */
  path: string[];
  children: TeamNode[];
}

/**
 * The team tree from `parentTeamId`, roots in `groupByTeam` order and children
 * by size then name. A parent that is gone (or a loop from two devices'
 * edits) makes a team a root. `NO_TEAM` is left out.
 */
export function teamForest(groups: readonly TeamGroup[]): TeamNode[] {
  const named = groups.filter((g) => g.team !== NO_TEAM);
  const byId = new Map<string, TeamGroup>();
  for (const g of named) if (g.info) byId.set(g.info.id, g);
  const parentOf = (g: TeamGroup): TeamGroup | undefined => {
    const pid = g.info?.parentTeamId;
    if (!pid) return undefined;
    // Walk up to make sure g is not inside a loop.
    const seen = new Set<string>([g.info!.id]);
    let cur = byId.get(pid);
    while (cur) {
      if (seen.has(cur.info!.id)) return undefined;
      seen.add(cur.info!.id);
      const next = cur.info?.parentTeamId;
      if (!next) break;
      cur = byId.get(next);
    }
    return byId.get(pid);
  };
  const kids = new Map<TeamGroup, TeamGroup[]>();
  const roots: TeamGroup[] = [];
  for (const g of named) {
    const p = parentOf(g);
    if (p) kids.set(p, [...(kids.get(p) ?? []), g]);
    else roots.push(g);
  }
  const build = (g: TeamGroup, path: string[]): TeamNode => ({
    group: g,
    path,
    children: (kids.get(g) ?? [])
      .sort((a, b) => b.people.length - a.people.length || a.team.localeCompare(b.team))
      .map((c) => build(c, [...path, g.team])),
  });
  return roots.map((g) => build(g, []));
}

/** Every node of a forest, depth first. */
export function flattenTeams(forest: readonly TeamNode[]): TeamNode[] {
  const out: TeamNode[] = [];
  const walk = (n: TeamNode) => { out.push(n); n.children.forEach(walk); };
  forest.forEach(walk);
  return out;
}

/** Everyone in a team and the teams below it, once each. */
export function peopleUnder(node: TeamNode): PersonSummary[] {
  const seen = new Map<string, PersonSummary>();
  for (const n of flattenTeams([node])) for (const p of n.group.people) seen.set(p.id, p);
  return [...seen.values()];
}
