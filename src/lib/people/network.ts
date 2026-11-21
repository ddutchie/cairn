/**
 * Pure derivation for the Insights relationship canvas and org chart (W7):
 * which links exist between people, which are drawn under the current filter,
 * and the reporting tree. No React and no store, so the rules are unit-tested.
 *
 * Two sources of links:
 * - person-to-person edges (`person_edges`), one stored direction each;
 * - the user's own relationship to each person (`people.relationship`), which
 *   becomes a link to the `is_me` person when there is one. Stored edges win
 *   over these derived links for the same pair and kind.
 *
 * Nothing here counts activity. Co-attendance is "met in the same meeting"
 * and is off unless the user turns it on.
 */

import type { PersonEdge, PersonEdgeType, RelationshipType } from "../../../shared/types/people";
import type { CoAttendance, PersonSummary } from "../../../shared/types/people-view";

export const LINK_KINDS = ["reporting", "mentor", "buddy", "stakeholder", "peer", "partner", "meeting"] as const;
export type LinkKind = (typeof LINK_KINDS)[number];

export const LINK_KIND_LABELS: Record<LinkKind, string> = {
  reporting: "Reporting line",
  mentor: "Mentor",
  buddy: "Buddy",
  stakeholder: "Stakeholder",
  peer: "Peer",
  partner: "Partner",
  meeting: "Meetings together",
};

/** Kinds shown when the canvas opens: relationships, not meetings. */
export const DEFAULT_LINK_KINDS: readonly LinkKind[] = ["reporting", "mentor", "buddy", "stakeholder", "peer", "partner"];

export interface NetworkLink {
  id: string;
  kind: LinkKind;
  /** For directed kinds: the manager / mentor / stakeholder-of side. */
  source: string;
  target: string;
  directed: boolean;
  label?: string;
  /** The relationship has ended ("former manager"). */
  ended: boolean;
  /** Inferred from a person's relationship to "me", not a stored edge. */
  derived: boolean;
  /** Co-attendance only: meetings together. */
  weight: number;
}

const EDGE_KIND: Record<PersonEdgeType, { kind: LinkKind; directed: boolean }> = {
  manager_of: { kind: "reporting", directed: true },
  mentor_of: { kind: "mentor", directed: true },
  buddy_of: { kind: "buddy", directed: true },
  stakeholder_of: { kind: "stakeholder", directed: true },
  partner: { kind: "partner", directed: false },
};

/** How a relationship chip reads as a link from me to them (`meFirst`) or them to me. */
const RELATIONSHIP_KIND: Partial<Record<RelationshipType, { kind: LinkKind; directed: boolean; meIsSource: boolean }>> = {
  direct_report: { kind: "reporting", directed: true, meIsSource: true },
  manager: { kind: "reporting", directed: true, meIsSource: false },
  peer: { kind: "peer", directed: false, meIsSource: true },
  // Same direction as the edge each chip stands for (shared/people/chip-edges.ts), so a chip and its edge are one link.
  stakeholder: { kind: "stakeholder", directed: true, meIsSource: false },
  mentor: { kind: "mentor", directed: true, meIsSource: false },
  buddy: { kind: "buddy", directed: true, meIsSource: false },
};

const pairKey = (kind: LinkKind, a: string, b: string, directed: boolean) =>
  directed ? `${kind}:${a}>${b}` : `${kind}:${[a, b].sort().join("|")}`;

/** The canonical "me" for a list: the oldest `isMe` person (matches the main process rule). */
export function findMe(people: readonly PersonSummary[]): PersonSummary | null {
  let me: PersonSummary | null = null;
  for (const p of people) {
    if (!p.isMe) continue;
    if (!me || p.createdAt < me.createdAt || (p.createdAt === me.createdAt && p.id < me.id)) me = p;
  }
  return me;
}

/**
 * Every link between the given people: stored edges, links derived from the
 * relationship chips, and (as `meeting` links) co-attendance. Links to anyone
 * not in `people` are dropped.
 */
export function deriveLinks(
  people: readonly PersonSummary[],
  edges: readonly PersonEdge[],
  coAttendance: readonly CoAttendance[],
): NetworkLink[] {
  const ids = new Set(people.map((p) => p.id));
  const links: NetworkLink[] = [];
  const seen = new Set<string>();

  for (const e of edges) {
    if (!ids.has(e.sourceId) || !ids.has(e.targetId) || e.sourceId === e.targetId) continue;
    const { kind, directed } = EDGE_KIND[e.type];
    const key = pairKey(kind, e.sourceId, e.targetId, directed);
    if (seen.has(key)) continue;
    // An edge decides for its pair, current or ended: the main process already took a chip away
    // when its edge to you ended (shared/people/chip-edges.ts), so a chip left here is a different fact.
    if (!e.endedAt) seen.add(key);
    links.push({
      id: `e:${e.id}`, kind, source: e.sourceId, target: e.targetId, directed,
      label: e.label, ended: !!e.endedAt, derived: false, weight: 1,
    });
  }

  const me = findMe(people);
  if (me) {
    for (const p of people) {
      if (p.id === me.id) continue;
      for (const rel of p.relationship) {
        const map = RELATIONSHIP_KIND[rel.type];
        if (!map) continue;
        const source = map.meIsSource ? me.id : p.id;
        const target = map.meIsSource ? p.id : me.id;
        const key = pairKey(map.kind, source, target, map.directed);
        if (seen.has(key)) continue;
        // A stored edge for the same pair and kind in the other direction
        // (e.g. they manage me, and I'm also marked as their manager) is the
        // user's explicit word; don't add a second line.
        if (seen.has(pairKey(map.kind, target, source, map.directed)) && map.kind !== "peer") continue;
        seen.add(key);
        links.push({
          id: `r:${p.id}:${rel.type}`, kind: map.kind, source, target, directed: map.directed,
          label: rel.label, ended: false, derived: true, weight: 1,
        });
      }
    }
  }

  for (const c of coAttendance) {
    if (!ids.has(c.a) || !ids.has(c.b) || c.a === c.b) continue;
    links.push({
      id: `m:${c.a}|${c.b}`, kind: "meeting", source: c.a, target: c.b, directed: false,
      ended: false, derived: false, weight: c.meetings,
    });
  }
  return links;
}

/** Links whose kind is switched on. */
export function filterLinks(links: readonly NetworkLink[], kinds: ReadonlySet<LinkKind>): NetworkLink[] {
  return links.filter((l) => kinds.has(l.kind));
}

/** Link kinds that have at least one link, for disabling empty filter chips. */
export function kindsPresent(links: readonly NetworkLink[]): Set<LinkKind> {
  return new Set(links.map((l) => l.kind));
}

// ── Org chart ────────────────────────────────────────────────────────────────

export interface OrgNode {
  person: PersonSummary;
  children: OrgNode[];
  /** Other managers, when someone reports to more than one (matrix). */
  alsoReportsTo: string[];
  /** This person's own manager link was cut to break a cycle. */
  cycleBroken: boolean;
}

export interface OrgChart {
  /** Reporting trees. Includes `me` as a lone root when nobody links to them. */
  roots: OrgNode[];
  /** Everyone not in a reporting line, for the strip under the chart. */
  unplaced: PersonSummary[];
  /** Number of cycles that had to be cut. */
  cyclesBroken: number;
}

/**
 * The reporting forest. A person's manager is the earliest current
 * `manager_of` edge into them (others become `alsoReportsTo`); ended edges are
 * history, not structure. `direct_report` / `manager` chips on the `is_me`
 * person's relations fill in only where no stored edge gives that person a
 * manager. A cycle is cut at its alphabetically-first member, who becomes a
 * root. Siblings sort by name.
 */
export function buildOrgChart(people: readonly PersonSummary[], links: readonly NetworkLink[]): OrgChart {
  const byId = new Map(people.map((p) => [p.id, p]));
  const me = findMe(people);

  // Candidate manager links, stored before derived, then by input order (edges arrive by created_at).
  const reporting = links.filter((l) => l.kind === "reporting" && !l.ended && byId.has(l.source) && byId.has(l.target));
  const ordered = [...reporting.filter((l) => !l.derived), ...reporting.filter((l) => l.derived)];
  const parent = new Map<string, string>();
  const parentDerived = new Map<string, boolean>();
  const also = new Map<string, string[]>();
  for (const l of ordered) {
    const cur = parent.get(l.target);
    if (cur === undefined) { parent.set(l.target, l.source); parentDerived.set(l.target, l.derived); }
    // A stored manager outranks chip-derived ones; among chips (or stored edges) the rest are additional.
    else if (cur !== l.source && (!l.derived || parentDerived.get(l.target))) also.set(l.target, [...(also.get(l.target) ?? []), l.source]);
  }

  // Break cycles: follow parents; any member reached twice in one walk is in a cycle.
  const nameOf = (id: string) => byId.get(id)!.name.toLocaleLowerCase();
  const cmp = (a: string, b: string) => nameOf(a).localeCompare(nameOf(b)) || (a < b ? -1 : a > b ? 1 : 0);
  const state = new Map<string, 1 | 2>(); // 1 = on the current walk, 2 = done
  const broken = new Set<string>();
  for (const start of byId.keys()) {
    const path: string[] = [];
    let cur: string | undefined = start;
    while (cur !== undefined && state.get(cur) !== 2) {
      if (state.get(cur) === 1) {
        const cycle = path.slice(path.indexOf(cur));
        const cut = [...cycle].sort(cmp)[0];
        parent.delete(cut);
        broken.add(cut);
        break;
      }
      state.set(cur, 1);
      path.push(cur);
      cur = parent.get(cur);
    }
    for (const id of path) state.set(id, 2);
  }

  const kids = new Map<string, string[]>();
  for (const [child, par] of parent) kids.set(par, [...(kids.get(par) ?? []), child]);
  const inChart = new Set<string>();
  for (const [child, par] of parent) { inChart.add(child); inChart.add(par); }
  for (const [child, others] of also) { inChart.add(child); for (const o of others) inChart.add(o); }
  if (me) inChart.add(me.id);

  const build = (id: string): OrgNode => ({
    person: byId.get(id)!,
    children: (kids.get(id) ?? []).sort(cmp).map(build),
    alsoReportsTo: also.get(id) ?? [],
    cycleBroken: broken.has(id),
  });
  const rootIds = [...inChart].filter((id) => !parent.has(id)).sort((a, b) => {
    // Me first when they head a tree, then the biggest trees, then name.
    if (me && (a === me.id) !== (b === me.id)) return a === me.id ? -1 : 1;
    const size = (x: string) => countDescendants(kids, x);
    return size(b) - size(a) || cmp(a, b);
  });
  const roots = rootIds.map(build);
  return {
    roots,
    unplaced: people.filter((p) => !inChart.has(p.id)).sort((a, b) => cmp(a.id, b.id)),
    cyclesBroken: broken.size,
  };
}

function countDescendants(kids: Map<string, string[]>, id: string): number {
  let n = 0;
  const stack = [...(kids.get(id) ?? [])];
  while (stack.length) { n++; stack.push(...(kids.get(stack.pop()!) ?? [])); }
  return n;
}

/** The chain from the root to `id` inclusive, for highlighting "my line". */
export function pathTo(roots: readonly OrgNode[], id: string): string[] {
  const walk = (n: OrgNode, trail: string[]): string[] | null => {
    const next = [...trail, n.person.id];
    if (n.person.id === id) return next;
    for (const c of n.children) { const r = walk(c, next); if (r) return r; }
    return null;
  };
  for (const r of roots) { const p = walk(r, []); if (p) return p; }
  return [];
}
