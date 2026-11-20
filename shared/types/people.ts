/**
 * People layer entity types, shared by the main process
 * (`electron/db/people-queries.ts`), the IPC contract and the renderer.
 * Plan: docs/plans/people-layer.md.
 */

import type { ID } from "./domain";

/** Known relationship types; `label` carries anything more specific. */
export const RELATIONSHIP_TYPES = [
  "direct_report", "manager", "peer", "stakeholder", "mentor", "buddy", "recruiter", "candidate", "other",
] as const;
export type RelationshipType = (typeof RELATIONSHIP_TYPES)[number];

/** How a fact was found: stated in text, from a folder/tag/property pattern, or the model's judgment. */
export const PROVENANCES = ["explicit", "convention", "inferred"] as const;
export type Provenance = (typeof PROVENANCES)[number];

/** Suggested rows are proposals waiting for the user; dismissed ones are remembered so they don't return. */
export const PEOPLE_STATUSES = ["confirmed", "suggested", "dismissed"] as const;
export type PeopleStatus = (typeof PEOPLE_STATUSES)[number];

export interface Relationship {
  type: RelationshipType;
  /** Free text, e.g. "onboarding buddy", "AA-in-MC trifecta". */
  label?: string;
  provenance: Provenance;
}

export const CADENCES = ["weekly", "biweekly", "monthly"] as const;
export type Cadence = (typeof CADENCES)[number];

export type Person = {
  id: ID;
  workspaceId: ID;
  name: string;
  aliases: string[];
  emails: string[];
  slackId?: string;
  /** Relationship to the user. A set: someone can be a stakeholder and a mentor. */
  relationship: Relationship[];
  cadence?: Cadence;
  personaNoteId?: ID;
  status: PeopleStatus;
  provenance: Provenance;
  /** Hiring stage, for candidates. */
  stage?: string;
  /** Role, place and IANA time zone: what you know about them, in your words. */
  title?: string;
  /**
   * Their home team's name, read from `team_memberships` (the first current
   * membership of a team of kind "team", else of any kind). Read-only: write
   * membership with `PersonPatch.team` or the team queries.
   */
  team?: string;
  /** Every team they are on now, home team first. */
  teams: PersonTeam[];
  location?: string;
  timezone?: string;
  /** The user themself; one per workspace. */
  isMe: boolean;
  /** When true, the persona note is left out of every agent read. */
  agentPrivate: boolean;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
};

/**
 * Stored person-to-person edge types, one direction each. `partner` is
 * symmetric; the others read "source is <type> target" (source manages target).
 */
export const PERSON_EDGE_TYPES = ["manager_of", "mentor_of", "buddy_of", "stakeholder_of", "partner"] as const;
export type PersonEdgeType = (typeof PERSON_EDGE_TYPES)[number];
/** What the agent's `link` takes: an edge type (personId <type> otherPersonId), or a note to put personId on. */
export const LINK_KINDS = [...PERSON_EDGE_TYPES, "attendee", "mention"] as const;

/** An edge as seen from one person, including the derived inverse ("reports_to"). */
export type PersonEdgeRole =
  | "manager_of" | "reports_to"
  | "mentor_of" | "mentee_of"
  | "buddy_of" | "buddy_to"
  | "stakeholder_of" | "has_stakeholder"
  | "partner";

export type PersonEdge = {
  id: ID;
  workspaceId: ID;
  sourceId: ID;
  targetId: ID;
  type: PersonEdgeType;
  label?: string;
  /** Set when the relationship is over ("former manager"). */
  endedAt?: string;
  status: PeopleStatus;
  provenance: Provenance;
  sourceNoteId?: ID;
  createdAt: string;
  updatedAt: string;
};

/** One edge from the perspective of `personId`: who's on the other end and in which role. */
export interface PersonRelation {
  edge: PersonEdge;
  role: PersonEdgeRole;
  otherId: ID;
}

export const MEETING_SOURCES = ["calendar", "note", "manual"] as const;
export type MeetingSource = (typeof MEETING_SOURCES)[number];

export type Meeting = {
  id: ID;
  workspaceId: ID;
  title: string;
  startsAt: string;
  endsAt?: string;
  source: MeetingSource;
  /** Calendar event id, so repeated Today runs update rather than duplicate. */
  externalId?: string;
  /** Recurring series, for cadence and "last 1:1". */
  seriesKey?: string;
  createdAt: string;
  updatedAt: string;
};

export const ATTENDEE_SOURCES = ["calendar", "frontmatter", "declared", "body_line", "manual"] as const;
export type AttendeeSource = (typeof ATTENDEE_SOURCES)[number];

export type MeetingAttendee = {
  id: ID;
  meetingId: ID;
  personId: ID;
  /** Suggested when the name match was ambiguous or inferred. */
  status: PeopleStatus;
  /** The strongest source that lists this person. */
  source: AttendeeSource;
  /** Every source that lists this person; they stay at the meeting until the last one drops them. */
  sources: AttendeeSource[];
  provenance: Provenance;
  createdAt: string;
  updatedAt: string;
};

export const MENTION_SOURCES = ["wikilink", "owner", "manual"] as const;
export type MentionSource = (typeof MENTION_SOURCES)[number];

export type NoteMention = {
  id: ID;
  noteId: ID;
  personId: ID;
  source: MentionSource;
  createdAt: string;
  updatedAt: string;
};

/** Fields accepted when creating a person (everything but the name is optional). */
export interface PersonCreateInput {
  id?: ID;
  workspaceId: ID;
  name: string;
  aliases?: string[];
  emails?: string[];
  slackId?: string;
  relationship?: Relationship[];
  cadence?: Cadence;
  personaNoteId?: ID;
  status?: PeopleStatus;
  provenance?: Provenance;
  stage?: string;
  title?: string;
  team?: string;
  location?: string;
  timezone?: string;
  isMe?: boolean;
  agentPrivate?: boolean;
}

/** A partial update. `null` clears an optional field. */
export type PersonPatch = Partial<{
  name: string;
  aliases: string[];
  emails: string[];
  slackId: string | null;
  relationship: Relationship[];
  cadence: Cadence | null;
  personaNoteId: ID | null;
  status: PeopleStatus;
  provenance: Provenance;
  stage: string | null;
  title: string | null;
  /** Move them to this team (by name, created when new), off their other teams of kind "team". `null` takes them off those. */
  team: string | null;
  location: string | null;
  timezone: string | null;
  isMe: boolean;
  agentPrivate: boolean;
  archivedAt: string | null;
}>;

// ── Teams ─────────────────────────────────────

/** A link on a team: its board, docs, on-call page. */
export interface TeamLink {
  label: string;
  url: string;
}

/**
 * What a group is. A person has one home team of kind "team" at a time; they
 * can be in any number of guilds, projects and committees beside it.
 */
export const TEAM_KINDS = ["team", "guild", "project", "committee"] as const;
export type TeamKind = (typeof TEAM_KINDS)[number];

/**
 * What you know about a team. Its id is fixed when it is made (from the
 * workspace and the name, so two devices making "Sync" make one row) and
 * kept through renames; membership points at the id (`TeamMembership`).
 */
export type Team = {
  id: ID;
  workspaceId: ID;
  name: string;
  kind: TeamKind;
  /** What the team owns and works on, in your words. */
  description?: string;
  leadPersonId?: ID;
  /** The team this one sits under, for the org chart. */
  parentTeamId?: ID;
  /** Where to reach the team, e.g. "#sync-team". */
  channel?: string;
  links: TeamLink[];
  createdAt: string;
  updatedAt: string;
};

/**
 * One person on one team. One row per pair (id from both), so a second stint
 * reuses the row: joining again clears `endedAt` and sets a new `startedAt`.
 * Leaving sets `endedAt`, which keeps who was on the team and when.
 */
export type TeamMembership = {
  id: ID;
  workspaceId: ID;
  teamId: ID;
  personId: ID;
  /** Their part on the team, in your words: "Tech lead", "Embedded from Design". */
  role?: string;
  startedAt?: string;
  endedAt?: string;
  createdAt: string;
  updatedAt: string;
};

export interface AddMemberInput {
  teamId: string;
  personId: string;
  /** Free text; `null` clears it, undefined keeps what is there. */
  role?: string | null;
  /** When they joined. Default: now, for a new or ended membership. `null` means unknown. */
  startedAt?: string | null;
}

/** A current membership as a person carries it. */
export interface PersonTeam {
  teamId: ID;
  name: string;
  kind: TeamKind;
  role?: string;
  startedAt?: string;
}

export interface TeamCreateInput {
  id?: ID;
  workspaceId: ID;
  name: string;
  kind?: TeamKind;
  description?: string;
  leadPersonId?: ID;
  parentTeamId?: ID;
  channel?: string;
  links?: TeamLink[];
}

/** A partial update. `null` clears an optional field. A rename keeps the id, so members stay. */
export type TeamPatch = Partial<{
  name: string;
  kind: TeamKind;
  description: string | null;
  leadPersonId: ID | null;
  parentTeamId: ID | null;
  channel: string | null;
  links: TeamLink[];
}>;
