/**
 * Pure helpers for the People view: relationship groups, search, and how an
 * edge reads from one person's side ("Reports to Elisa"). No React, so the
 * grouping rules are unit-tested on their own.
 */

import type {
  Cadence, PersonEdgeRole, PersonEdgeType, Relationship, RelationshipType,
} from "../../../shared/types/people";
import type { PersonRelationView, PersonSummary } from "../../../shared/types/people-view";

/** List groups, in display order. A person shows in every group their relationship set matches. */
export const PEOPLE_GROUPS = [
  { key: "direct_report", label: "Direct reports", types: ["direct_report"] },
  { key: "manager", label: "Manager", types: ["manager"] },
  { key: "peer", label: "Peers", types: ["peer"] },
  { key: "stakeholder", label: "Stakeholders", types: ["stakeholder"] },
  { key: "mentor", label: "Mentors", types: ["mentor"] },
  { key: "candidate", label: "Candidates", types: ["candidate"] },
  { key: "other", label: "Other", types: ["buddy", "recruiter", "other"] },
] as const satisfies readonly { key: string; label: string; types: readonly RelationshipType[] }[];

export type PeopleGroupKey = (typeof PEOPLE_GROUPS)[number]["key"];

export const RELATIONSHIP_LABELS: Record<RelationshipType, string> = {
  direct_report: "Direct report",
  manager: "Manager",
  peer: "Peer",
  stakeholder: "Stakeholder",
  mentor: "Mentor",
  buddy: "Buddy",
  recruiter: "Recruiter",
  candidate: "Candidate",
  other: "Other",
};

export const CADENCE_LABELS: Record<Cadence, string> = {
  weekly: "Weekly",
  biweekly: "Every two weeks",
  monthly: "Monthly",
};

/** Case- and accent-insensitive text for search ("Sébastien" matches "sebastien"). */
export function foldText(s: string): string {
  return s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/** True when the person's name, aliases, emails or relationship labels contain the query. */
export function matchesPersonQuery(person: PersonSummary, query: string): boolean {
  const q = foldText(query.trim());
  if (!q) return true;
  const hay = [
    person.name,
    ...person.aliases,
    ...person.emails,
    ...person.relationship.map((r) => r.label ?? ""),
    ...person.relationship.map((r) => RELATIONSHIP_LABELS[r.type]),
  ].join(" ");
  return foldText(hay).includes(q);
}

export interface PeopleGroup {
  key: PeopleGroupKey;
  label: string;
  people: PersonSummary[];
}

/** The group keys a relationship set falls into; none means "Other". */
export function groupKeysFor(relationship: readonly Relationship[]): PeopleGroupKey[] {
  const keys = PEOPLE_GROUPS
    .filter((g) => relationship.some((r) => (g.types as readonly RelationshipType[]).includes(r.type)))
    .map((g) => g.key);
  return keys.length ? keys : ["other"];
}

/**
 * Group people by relationship to the user, in PEOPLE_GROUPS order, dropping
 * empty groups. Someone who is a stakeholder and a mentor is listed in both.
 * `only` narrows to one group; `query` filters by {@link matchesPersonQuery}.
 */
export function groupPeople(
  people: readonly PersonSummary[],
  opts: { query?: string; only?: PeopleGroupKey | null } = {},
): PeopleGroup[] {
  const buckets = new Map<PeopleGroupKey, PersonSummary[]>();
  for (const p of people) {
    if (opts.query && !matchesPersonQuery(p, opts.query)) continue;
    for (const key of groupKeysFor(p.relationship)) {
      if (opts.only && key !== opts.only) continue;
      const list = buckets.get(key) ?? [];
      list.push(p);
      buckets.set(key, list);
    }
  }
  return PEOPLE_GROUPS
    .filter((g) => buckets.has(g.key))
    .map((g) => ({
      key: g.key,
      label: g.label,
      people: [...buckets.get(g.key)!].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" })),
    }));
}

/** How a relation reads on the person page, from that person's side. */
export function describeRelation(r: Pick<PersonRelationView, "role" | "otherName" | "edge">): string {
  const n = r.otherName;
  const base: Record<PersonEdgeRole, string> = {
    reports_to: `Reports to ${n}`,
    manager_of: `Manages ${n}`,
    mentee_of: `Mentor: ${n}`,
    mentor_of: `Mentors ${n}`,
    buddy_to: `Buddy: ${n}`,
    buddy_of: `Buddy to ${n}`,
    has_stakeholder: `Stakeholder: ${n}`,
    stakeholder_of: `Stakeholder for ${n}`,
    partner: `Works with ${n}`,
  };
  const label = r.edge.label ? `, ${r.edge.label}` : "";
  return `${base[r.role]}${label}${r.edge.endedAt ? " (former)" : ""}`;
}

/** Roles offered when adding an edge from a person's page, with the stored type and direction. */
export const EDGE_ROLE_OPTIONS: { role: PersonEdgeRole; label: string; type: PersonEdgeType; thisIsSource: boolean }[] = [
  { role: "reports_to", label: "Reports to", type: "manager_of", thisIsSource: false },
  { role: "manager_of", label: "Manages", type: "manager_of", thisIsSource: true },
  { role: "mentee_of", label: "Is mentored by", type: "mentor_of", thisIsSource: false },
  { role: "mentor_of", label: "Mentors", type: "mentor_of", thisIsSource: true },
  { role: "buddy_to", label: "Has buddy", type: "buddy_of", thisIsSource: false },
  { role: "buddy_of", label: "Is buddy to", type: "buddy_of", thisIsSource: true },
  { role: "has_stakeholder", label: "Has stakeholder", type: "stakeholder_of", thisIsSource: false },
  { role: "stakeholder_of", label: "Is stakeholder for", type: "stakeholder_of", thisIsSource: true },
  { role: "partner", label: "Works with", type: "partner", thisIsSource: true },
];

/** Split a comma- or newline-separated field into trimmed, non-empty entries. */
export function splitList(text: string): string[] {
  return text.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
}
