/**
 * People grouped by team (People view, "Teams"; the org chart's team tree;
 * the agent's team reads). Membership is each person's `teams` (from
 * `team_memberships`); a person who carries only a `team` name (older data,
 * fixtures) counts as on the team of that name. Someone on two teams is in
 * both groups. Pure: the views only draw what this returns.
 */
import type { RelationshipType, Team } from "../types/people";
import type { PersonSummary } from "../types/people-view";

export const NO_TEAM = "No team";
/** The key of the `NO_TEAM` group. */
export const NO_TEAM_KEY = "_none";

export interface TeamGroup {
  /** Stable key: the team id, `name:<folded name>` for a name with no team row, `NO_TEAM_KEY` for nobody's team. */
  key: string;
  /** Display name; `NO_TEAM` for people without one. */
  team: string;
  people: PersonSummary[];
  /** Each member's role on this team, when one is recorded. */
  roles: Record<string, string>;
  /** How many of them hold each relationship to you (someone with two counts in both). */
  byRelationship: Partial<Record<RelationshipType, number>>;
  /** Distinct time zones in the team, for a quick "spread across" hint. */
  timezones: string[];
  /** The team's details, when it has a `teams` row. */
  info?: Team;
}

const norm = (t: string | undefined): string => (t ?? "").trim().replace(/\s+/g, " ");
const fold = (t: string | undefined): string => norm(t).toLowerCase();

/** The teams someone is on now, as (id?, name, role?). */
function teamsOf(p: PersonSummary): { id?: string; name: string; role?: string }[] {
  if (p.teams?.length) return p.teams.map((t) => ({ id: t.teamId, name: t.name, role: t.role }));
  return norm(p.team) ? [{ name: norm(p.team) }] : [];
}

/**
 * Teams largest first, then by name; people with no team last. `teams` adds
 * each team's details, and a team with details but nobody on it yet is listed
 * too (empty). Two teams that share a name stay two groups.
 */
export function groupByTeam(people: readonly PersonSummary[], teams: readonly Team[] = []): TeamGroup[] {
  const map = new Map<string, TeamGroup>();
  const byName = new Map<string, string>();
  const group = (key: string, team: string, info?: Team): TeamGroup => {
    let g = map.get(key);
    if (!g) { g = { key, team, people: [], roles: {}, byRelationship: {}, timezones: [], info }; map.set(key, g); }
    return g;
  };
  for (const t of [...teams].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))) {
    const name = norm(t.name);
    if (!name) continue;
    group(t.id, name, t);
    if (!byName.has(fold(name))) byName.set(fold(name), t.id);
  }
  for (const p of people) {
    const mine = teamsOf(p);
    const groups = mine.length === 0
      ? [{ g: group(NO_TEAM_KEY, NO_TEAM), role: undefined }]
      : mine.map((t) => {
          // A membership names its team: use that, and match by name only for a person with no team id.
          const key = t.id ?? byName.get(fold(t.name)) ?? `name:${fold(t.name)}`;
          return { g: group(key, t.name), role: t.role };
        });
    for (const { g, role } of groups) {
      if (g.people.includes(p)) continue;
      g.people.push(p);
      if (role) g.roles[p.id] = role;
      for (const r of new Set(p.relationship.map((x) => x.type))) g.byRelationship[r] = (g.byRelationship[r] ?? 0) + 1;
      if (p.timezone && !g.timezones.includes(p.timezone)) g.timezones.push(p.timezone);
    }
  }
  for (const g of map.values()) g.people.sort((a, b) => a.name.localeCompare(b.name));
  return [...map.values()].sort((a, b) => {
    if ((a.key === NO_TEAM_KEY) !== (b.key === NO_TEAM_KEY)) return a.key === NO_TEAM_KEY ? 1 : -1;
    return b.people.length - a.people.length || a.team.localeCompare(b.team);
  });
}

/** Groups whose team shares its name with another team's: two devices named them alike before syncing. */
export function duplicateNames(groups: readonly TeamGroup[]): Map<string, TeamGroup[]> {
  const out = new Map<string, TeamGroup[]>();
  for (const g of groups) if (g.info) out.set(fold(g.team), [...(out.get(fold(g.team)) ?? []), g]);
  for (const [k, v] of out) if (v.length < 2) out.delete(k);
  return out;
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
  const named = groups.filter((g) => g.key !== NO_TEAM_KEY);
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
